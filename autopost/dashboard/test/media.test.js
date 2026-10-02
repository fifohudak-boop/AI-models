// Runs the real ffmpeg conversion on generated clips. Skipped when ffmpeg
// isn't installed (it always is in the Docker image).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopost-media-'));
process.env.DATA_DIR = dir;
const { encodeArgs, isStillImage, needsEncode, probe } = await import('../server/media.js');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg not installed';

function make(name, args) {
  const file = path.join(dir, name);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  return file;
}

async function convert(input) {
  const info = await probe(input);
  const output = `${input}.out.mp4`;
  const { args, reencoded } = encodeArgs(input, output, info);
  execFileSync('ffmpeg', args.filter((a) => a !== 'pipe:1' && a !== '-progress'), { stdio: 'ignore' });
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', output], {
      encoding: 'utf8',
    })
  );
  const video = out.streams.find((s) => s.codec_type === 'video');
  const audio = out.streams.find((s) => s.codec_type === 'audio');
  return { info, reencoded, video, audio, format: out.format };
}

const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'];

test('iPhone HDR (HLG, HEVC 10-bit, .mov) becomes SDR H.264 MP4', { skip }, async () => {
  const input = make('hdr.mov', [
    '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30:duration=2', ...tone,
    '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
    // tag it like an iPhone does (inside the HEVC stream, not just the container)
    '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
    '-c:a', 'aac', '-shortest',
  ]);
  const { info, reencoded, video, audio, format } = await convert(input);
  assert.equal(info.video.hdr, true);
  assert.equal(reencoded, true);
  assert.equal(video.codec_name, 'h264');
  assert.equal(video.pix_fmt, 'yuv420p');
  assert.equal(video.color_transfer, 'bt709');
  assert.equal(audio.codec_name, 'aac');
  assert.match(format.format_name, /mp4/);
  assert.deepEqual([video.width, video.height], [720, 1280]);
});

test('an already-compatible H.264/AAC MP4 is only re-wrapped (no quality loss)', { skip }, async () => {
  const input = make('ok.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2', ...tone,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ]);
  const { info, reencoded, video } = await convert(input);
  assert.ok(info.bitRate < 12_000_000, `test clip bitrate ${info.bitRate}`);
  assert.equal(reencoded, false);
  assert.equal(video.codec_name, 'h264');
});

test('4K and 120 fps are brought down to 1920px and 60 fps', { skip }, async () => {
  const input = make('big.mp4', [
    '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=120:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  ]);
  const { reencoded, video, audio } = await convert(input);
  assert.equal(reencoded, true);
  assert.deepEqual([video.width, video.height], [1920, 1080]);
  assert.equal(video.avg_frame_rate, '60/1');
  assert.equal(audio, undefined, 'no audio track invented for silent videos');
});

test('odd sizes stay encodable (even dimensions)', { skip }, async () => {
  const input = make('odd.webm', [
    '-f', 'lavfi', '-i', 'testsrc2=size=721x1281:rate=30:duration=1',
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
  ]);
  const { reencoded, video } = await convert(input);
  assert.equal(reencoded, true);
  assert.equal(video.width % 2, 0);
  assert.equal(video.height % 2, 0);
});

test('photos are recognized as photos', { skip }, async () => {
  const jpg = make('photo.jpg', ['-f', 'lavfi', '-i', 'testsrc2=size=1200x800', '-frames:v', '1']);
  assert.equal(isStillImage(await probe(jpg)), true);
  const mp4 = make('clip.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:duration=1', '-pix_fmt', 'yuv420p']);
  assert.equal(isStillImage(await probe(mp4)), false);
});

test('decision rules without running ffmpeg', () => {
  const base = { bitRate: 4_000_000, audioCodec: 'aac', video: { codec: 'h264', pixFmt: 'yuv420p', width: 1080, height: 1920, fps: 30, hdr: false } };
  assert.equal(needsEncode(base), false);
  assert.equal(needsEncode({ ...base, bitRate: 40_000_000 }), true, 'camera originals get compressed');
  assert.equal(needsEncode({ ...base, audioCodec: 'opus' }), true);
  assert.equal(needsEncode({ ...base, audioCodec: null }), false, 'silent video is fine');
  assert.equal(needsEncode({ ...base, video: { ...base.video, hdr: true } }), true);
  assert.equal(needsEncode({ ...base, video: { ...base.video, codec: 'hevc' } }), true);
});
