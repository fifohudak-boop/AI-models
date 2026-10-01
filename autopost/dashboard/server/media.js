// Turns whatever the user drops in (iPhone .mov, 4K HEVC, a photo, ...) into
// files every network accepts, then hands them to Postiz.
//
// Videos become H.264/AAC MP4 with the index at the front ("faststart"),
// at most 1920px on the long side and 60 fps — the common denominator of
// YouTube, TikTok, Instagram, Facebook, X, LinkedIn, Threads and Bluesky.
// Already-compatible videos are only re-wrapped (seconds, no quality loss).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UPLOAD_TMP_DIR } from './config.js';
import { postiz } from './postiz.js';

const MAX_LONG_SIDE = 1920;
const MAX_FPS = 60;
// Above this the file is re-encoded even if compatible, so camera originals
// don't blow past upload limits (Postiz 1 GB, X 512 MB, ...).
const MAX_COPY_BITRATE = 12_000_000;
const POSTIZ_IMAGE_LIMIT = 10 * 1024 * 1024;
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']); // HLG (iPhone), PQ

const jobs = new Map();

// Leftovers from a crash or restart mid-upload are never needed again.
for (const name of fs.readdirSync(UPLOAD_TMP_DIR)) {
  fs.rm(path.join(UPLOAD_TMP_DIR, name), { force: true, recursive: true }, () => {});
}

function run(cmd, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} failed: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

export async function probe(file) {
  const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
  const info = JSON.parse(out);
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const [num, den] = String(video?.avg_frame_rate || video?.r_frame_rate || '0/1').split('/').map(Number);
  const rotation = Math.abs(
    Number(video?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)
  );
  const swap = rotation === 90 || rotation === 270;
  return {
    formatName: info.format?.format_name ?? '',
    majorBrand: (info.format?.tags?.major_brand ?? '').trim(),
    durationSeconds: Number(info.format?.duration) || 0,
    bitRate: Number(info.format?.bit_rate) || 0,
    video: video
      ? {
          codec: video.codec_name,
          pixFmt: video.pix_fmt,
          width: swap ? video.height : video.width,
          height: swap ? video.width : video.height,
          fps: den ? num / den : 0,
          hdr: HDR_TRANSFERS.has(video.color_transfer),
        }
      : null,
    audioCodec: audio?.codec_name ?? null,
  };
}

const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'gif', 'bmp', 'tiff']);

export function isStillImage(info) {
  if (!info.video) return false;
  return (
    IMAGE_CODECS.has(info.video.codec) &&
    (/image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|tiff_pipe/.test(info.formatName) || info.durationSeconds === 0)
  );
}

// Decides how much work a video needs: nothing but a re-wrap, or a re-encode.
export function needsEncode(info) {
  const v = info.video;
  return (
    v.codec !== 'h264' ||
    !['yuv420p', 'yuvj420p'].includes(v.pixFmt) ||
    v.hdr ||
    Math.max(v.width, v.height) > MAX_LONG_SIDE ||
    v.fps > MAX_FPS + 0.5 ||
    info.bitRate > MAX_COPY_BITRATE ||
    (info.audioCodec !== null && info.audioCodec !== 'aac')
  );
}

export function encodeArgs(input, output, info) {
  const reencoded = needsEncode(info);
  const args = ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1'];
  if (!reencoded) {
    args.push('-c', 'copy');
  } else {
    const filters = [];
    // iPhone "HDR" (HLG) and other HDR video look washed out on most
    // networks unless tone-mapped down to normal (SDR) colors.
    if (info.video.hdr) {
      filters.push(
        'zscale=t=linear:npl=100',
        'format=gbrpf32le',
        'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0',
        'zscale=t=bt709:m=bt709:r=tv',
        'format=yuv420p'
      );
    }
    filters.push(
      `scale='if(gte(iw,ih),trunc(min(${MAX_LONG_SIDE},iw)/2)*2,-2)':'if(gte(iw,ih),-2,trunc(min(${MAX_LONG_SIDE},ih)/2)*2)'`,
      'setsar=1'
    );
    if (info.video.fps > MAX_FPS + 0.5) filters.push(`fps=${MAX_FPS}`);
    args.push(
      '-vf',
      filters.join(','),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-maxrate',
      '8M',
      '-bufsize',
      '16M',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-colorspace',
      'bt709',
      '-color_primaries',
      'bt709',
      '-color_trc',
      'bt709',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ac',
      '2'
    );
  }
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', output);
  return { args, reencoded };
}

async function makeCover(input, output, durationSeconds) {
  const at = Math.min(1, durationSeconds / 2).toFixed(2);
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-ss',
    at,
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale='trunc(min(1080,iw)/2)*2':-2",
    '-q:v',
    '3',
    output,
  ]);
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

async function processVideo(job, input, info) {
  const output = path.join(UPLOAD_TMP_DIR, `${job.id}.mp4`);
  const cover = path.join(UPLOAD_TMP_DIR, `${job.id}-cover.jpg`);
  job.cleanup.push(output, cover);

  const { args, reencoded } = encodeArgs(input, output, info);
  update(job, { status: 'processing', step: reencoded ? 'Converting video for all networks' : 'Preparing video', progress: 0 });
  const totalUs = info.durationSeconds * 1_000_000;
  await run('ffmpeg', args, {
    onStdout: (text) => {
      const match = text.match(/out_time_us=(\d+)/g);
      if (match && totalUs > 0) {
        const us = Number(match[match.length - 1].split('=')[1]);
        job.progress = Math.max(0, Math.min(99, Math.round((us / totalUs) * 100)));
      }
    },
  });
  await makeCover(output, cover, info.durationSeconds);

  const finalInfo = await probe(output);
  const sizeBytes = fs.statSync(output).size;
  update(job, { step: 'Sending video to Postiz', progress: 100 });
  const [video, coverUpload] = await Promise.all([postiz.upload(output, 'video/mp4'), postiz.upload(cover, 'image/jpeg')]);

  return {
    kind: 'video',
    video: { id: video.id, path: video.path },
    cover: { id: coverUpload.id, path: coverUpload.path },
    previewUrl: coverUpload.path,
    durationSeconds: finalInfo.durationSeconds,
    width: finalInfo.video.width,
    height: finalInfo.video.height,
    sizeBytes,
    reencoded,
  };
}

async function processImage(job, input, info) {
  let file = input;
  let mime = info.video.codec === 'png' ? 'image/png' : info.video.codec === 'mjpeg' ? 'image/jpeg' : null;
  const tooBig = fs.statSync(input).size > POSTIZ_IMAGE_LIMIT;
  if (!mime || tooBig) {
    update(job, { status: 'processing', step: 'Converting photo', progress: 0 });
    file = path.join(UPLOAD_TMP_DIR, `${job.id}.jpg`);
    job.cleanup.push(file);
    await run('ffmpeg', ['-y', '-hide_banner', '-i', input, '-frames:v', '1', '-vf', "scale='trunc(min(4096,iw)/2)*2':-2", '-q:v', '2', file]);
    mime = 'image/jpeg';
  }
  update(job, { status: 'processing', step: 'Sending photo to Postiz', progress: 100 });
  const uploaded = await postiz.upload(file, mime);
  return {
    kind: 'images',
    images: [{ id: uploaded.id, path: uploaded.path }],
    previewUrl: uploaded.path,
    width: info.video.width,
    height: info.video.height,
    sizeBytes: fs.statSync(file).size,
  };
}

export function startMediaJob(uploadedPath, originalName) {
  const job = {
    id: randomUUID(),
    name: originalName,
    status: 'processing',
    step: 'Checking file',
    progress: 0,
    result: null,
    error: null,
    cleanup: [uploadedPath],
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);

  (async () => {
    try {
      const info = await probe(uploadedPath);
      if (!info.video) throw new Error('This file has no video or picture in it.');
      const result = isStillImage(info)
        ? await processImage(job, uploadedPath, info)
        : await processVideo(job, uploadedPath, info);
      update(job, { status: 'ready', step: 'Ready', progress: 100, result: { ...result, name: originalName } });
    } catch (err) {
      const message = /Invalid data found|could not find codec|moov atom not found/i.test(err.message)
        ? "This file isn't a video or photo we can read."
        : err.message;
      update(job, { status: 'failed', error: message });
    } finally {
      for (const file of job.cleanup) fs.rm(file, { force: true }, () => {});
      job.cleanup = [];
    }
  })();

  return publicJob(job);
}

export function publicJob(job) {
  if (!job) return null;
  const { cleanup: _cleanup, ...rest } = job;
  return rest;
}

export function getMediaJob(id) {
  return publicJob(jobs.get(id));
}

export function getMediaResult(id) {
  const job = jobs.get(id);
  return job?.status === 'ready' ? { ...job.result } : null;
}

// Forget finished jobs after a day so memory doesn't grow forever.
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) if (job.updatedAt < cutoff) jobs.delete(id);
}, 60 * 60 * 1000).unref();
