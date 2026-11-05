import { setupAlbumActions } from './album.js';
import { setupLightbox } from './lightbox.js';
import { setupLogin } from './login.js';

export function setupCommon(): void {
  setupLogin();
  setupLightbox();
  setupAlbumActions();
}
