import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, '0.0.0.0', () => {
  console.log(`Family Wishlist server listening on http://0.0.0.0:${port}`);
});
