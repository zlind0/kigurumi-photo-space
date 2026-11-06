import { setupAlbumActions } from './album.js';
import { setupLightbox } from './lightbox.js';
import { setupLogin } from './login.js';
import { setupPeople } from './people.js';

export function setupCommon(): void {
  setupLogin();
  setupLightbox();
  setupAlbumActions();
  setupPeople();
}
