// Import (after tempdata.js) in tests that run code talking to Postiz: points
// Fifofarm at a fake Postiz on this port.
export const FAKE_POSTIZ_PORT = 45000 + Math.floor(Math.random() * 4000);
process.env.POSTIZ_INTERNAL_URL = `http://127.0.0.1:${FAKE_POSTIZ_PORT}`;
process.env.POSTIZ_API_KEY = 'KEY123';
