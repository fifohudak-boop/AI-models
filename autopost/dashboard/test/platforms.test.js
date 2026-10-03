import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPostRequest,
  buildSettings,
  countLength,
  fitCaption,
  platformCatalog,
  preflight,
  toPostizHtml,
  youtubeTitle,
} from '../server/platforms.js';

const video = {
  kind: 'video',
  name: 'clip.mov',
  video: { id: 'v1', path: 'https://p.example/uploads/v1.mp4' },
  cover: { id: 'c1', path: 'https://p.example/uploads/c1.jpg' },
  durationSeconds: 30,
  sizeBytes: 5_000_000,
};

const account = (identifier, extra = {}) => ({ id: `acc-${identifier}`, identifier, name: 'Me', disabled: false, ...extra });

test('captions become one <p> per line with HTML escaped, like the Postiz editor', () => {
  assert.equal(toPostizHtml('Tom & Jerry <3\n\nbye'), '<p>Tom &amp; Jerry &lt;3</p><p></p><p>bye</p>');
  assert.equal(toPostizHtml('a\r\nb'), '<p>a</p><p>b</p>');
});

test('X length uses weighted counting (links count as 23)', () => {
  assert.equal(countLength('x', 'hi https://example.com/a/very/long/path/that/keeps/going'), 3 + 23);
  assert.equal(countLength('threads', 'é'), 2);
  assert.equal(countLength('youtube', 'é'), 1);
});

test('fitCaption shortens to the limit at a word boundary', () => {
  const long = 'word '.repeat(100).trim();
  const { text, shortened } = fitCaption('x', long, 280);
  assert.equal(shortened, true);
  assert.ok(countLength('x', text) <= 280);
  assert.ok(text.endsWith('…'));
  assert.ok(!text.includes('wor…'), 'should not cut inside a word');
  assert.deepEqual(fitCaption('x', 'short', 280), { text: 'short', shortened: false });
});

test('fitCaption never exceeds the limit with emoji', () => {
  const text = '🎉'.repeat(400);
  const out = fitCaption('x', text, 280);
  assert.ok(countLength('x', out.text) <= 280);
});

test('YouTube title falls back to the first caption line and respects 2..100 chars', () => {
  assert.equal(youtubeTitle('', '\nMy trip\nmore', 'clip.mov'), 'My trip');
  assert.equal(youtubeTitle('  Set   title ', 'x', ''), 'Set title');
  assert.equal(youtubeTitle('', '', 'clip'), 'clip');
  assert.equal(youtubeTitle('', '', ''), 'New video');
  assert.equal(youtubeTitle('A', '', ''), 'A video');
  assert.ok(Array.from(youtubeTitle('x'.repeat(150), '', '')).length <= 100);
});

test('each network gets the settings Postiz requires', () => {
  const prefs = { youtubeVisibility: 'unlisted', tiktokPrivacy: 'SELF_ONLY', pinterestBoards: { 'acc-pinterest': '123' } };
  const input = { title: '', caption: 'Hello', mediaName: 'clip.mov' };
  assert.deepEqual(buildSettings(account('youtube'), input, prefs), {
    __type: 'youtube',
    title: 'Hello',
    type: 'unlisted',
    selfDeclaredMadeForKids: 'no',
    tags: [],
  });
  const tiktok = buildSettings(account('tiktok'), input, prefs);
  assert.equal(tiktok.privacy_level, 'SELF_ONLY');
  assert.equal(tiktok.content_posting_method, 'DIRECT_POST');
  for (const key of ['duet', 'stitch', 'comment', 'brand_content_toggle', 'brand_organic_toggle']) {
    assert.equal(typeof tiktok[key], 'boolean', key);
  }
  assert.equal(buildSettings(account('instagram-standalone'), input, prefs).post_type, 'post');
  assert.equal(buildSettings(account('x'), input, prefs).who_can_reply_post, 'everyone');
  assert.equal(buildSettings(account('pinterest'), input, prefs).board, '123');
  assert.deepEqual(buildSettings(account('bluesky'), input, prefs), { __type: 'bluesky' });
});

test('Pinterest gets the cover image next to the video; others just the video', () => {
  const req = (id) => buildPostRequest(account(id), { caption: 'c', media: video }, {}, 500).body.posts[0].value[0].image;
  assert.deepEqual(req('pinterest').map((m) => m.id), ['v1', 'c1']);
  assert.deepEqual(req('youtube').map((m) => m.id), ['v1']);
});

test('buildPostRequest: post now vs schedule, per-account caption, auto-shorten', () => {
  const now = buildPostRequest(account('x'), { caption: 'a '.repeat(200), media: video }, { autoShorten: true }, 280);
  assert.equal(now.body.type, 'now');
  assert.equal(now.shortened, true);
  assert.equal(now.body.posts[0].integration.id, 'acc-x');

  const later = buildPostRequest(
    account('bluesky'),
    { caption: 'main', captions: { 'acc-bluesky': 'special' }, media: null, scheduleAt: '2030-01-01T10:00:00.000Z' },
    {},
    300
  );
  assert.equal(later.body.type, 'schedule');
  assert.equal(later.body.date, '2030-01-01T10:00:00.000Z');
  assert.equal(later.body.posts[0].value[0].content, '<p>special</p>');
  assert.deepEqual(later.body.posts[0].value[0].image, []);

  const noShorten = buildPostRequest(account('x'), { caption: 'a '.repeat(200) }, { autoShorten: false }, 280);
  assert.equal(noShorten.shortened, false);
});

test('preflight blocks what would fail and warns about likely rejections', () => {
  assert.deepEqual(preflight(account('youtube'), { media: null, caption: 'hi' }, {}).problems, ['YouTube needs a video.']);
  assert.deepEqual(preflight(account('tiktok'), { media: null, caption: 'hi' }, {}).problems, [
    'TikTok needs a photo or video.',
  ]);
  assert.equal(preflight(account('x'), { media: null, caption: 'hi' }, {}).problems.length, 0);
  assert.equal(preflight(account('pinterest'), { media: video, caption: 'hi' }, { pinterestBoards: {} }).problems.length, 1);
  assert.equal(preflight(account('reddit'), { media: video, caption: 'hi' }, {}).problems.length, 1);
  assert.equal(preflight(account('x', { disabled: true }), { media: video, caption: 'hi' }, {}).problems.length, 1);
  const longVideo = { ...video, durationSeconds: 200 };
  assert.equal(preflight(account('x'), { media: longVideo, caption: 'hi' }, {}).warnings.length, 1);
  assert.equal(preflight(account('youtube'), { media: longVideo, caption: 'hi' }, {}).warnings.length, 0);
});

test('a network shows as connectable only when all its keys are set', () => {
  const catalog = platformCatalog({ YOUTUBE_CLIENT_ID: 'id', YOUTUBE_CLIENT_SECRET: ' ', X_API_KEY: 'k', X_API_SECRET: 's' });
  const yt = catalog.find((p) => p.identifier === 'youtube');
  assert.equal(yt.configured, false);
  assert.deepEqual(yt.missingKeys, ['YOUTUBE_CLIENT_SECRET']);
  assert.equal(catalog.find((p) => p.identifier === 'x').configured, true);
  assert.equal(catalog.find((p) => p.identifier === 'bluesky').configured, true);
  assert.equal(catalog.some((p) => p.identifier === 'telegram'), false);
});
