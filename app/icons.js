// Pictogrammes 2D, un par filière, dessinés comme les maquettes 3D.
import { COLORS } from './models.js';

const P = {
  nucleaire: (c) => `<path d="M4 21 C6 15 6 10 5 5 H11 C10 10 10 15 12 21Z" fill="#fff" stroke="#1c1f24" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M13 21 C15 16 15 12 14 8 H19 C18 12 18 16 20 21Z" fill="#fff" stroke="#1c1f24" stroke-width="1.3" stroke-linejoin="round"/>
    <rect x="4.6" y="6" width="6.8" height="1.6" fill="${c}"/><rect x="13.8" y="9" width="5.4" height="1.4" fill="${c}"/>
    <circle cx="8" cy="3" r="1.6" fill="#cfd4dc"/><circle cx="10.5" cy="2.2" r="1.2" fill="#e1e5ea"/>`,
  hydraulique: (c) => `<path d="M2 20 L8 9 L12 14 L16 7 L22 20Z" fill="#cfe5c4"/>
    <path d="M3 13 Q12 8 21 13 L21 16 Q12 11 3 16Z" fill="#d5d2cb" stroke="#1c1f24" stroke-width="1.2"/>
    <path d="M10 16 h4 v5 h-4z" fill="${c}"/>`,
  eolien: (c) => `<path d="M11.3 10 h1.4 l.6 12 h-2.6z" fill="#fff" stroke="#1c1f24" stroke-width="1.1"/>
    <circle cx="12" cy="9" r="1.3" fill="#fff" stroke="#1c1f24" stroke-width="1.1"/>
    <path d="M12 8 L12.8 1.5 L11.2 1.5Z M13 9.6 L19 12.5 L18.2 13.8Z M11 9.6 L5 12.5 L5.8 13.8Z" fill="#fff" stroke="#1c1f24" stroke-width="1" stroke-linejoin="round"/>
    <rect x="10" y="20" width="4" height="2" fill="${c}"/>`,
  solaire: (c) => `<circle cx="18" cy="5" r="3" fill="${c}"/>
    <path d="M3 18 L7 9 H17 L13 18Z" fill="#1f3f8f" stroke="#1c1f24" stroke-width="1.1" stroke-linejoin="round"/>
    <path d="M5 13.5 H15 M10.7 9 L8.7 18" stroke="#9fb6e8" stroke-width=".9"/><path d="M10 18 v4" stroke="#1c1f24" stroke-width="1.3"/>`,
  gaz: (c) => `<rect x="3" y="12" width="11" height="9" fill="#fff" stroke="#1c1f24" stroke-width="1.2"/>
    <rect x="15.5" y="4" width="2" height="17" fill="#fff" stroke="#1c1f24" stroke-width="1.1"/><rect x="19" y="6" width="2" height="15" fill="#fff" stroke="#1c1f24" stroke-width="1.1"/>
    <rect x="15.5" y="6" width="2" height="1.6" fill="${c}"/><rect x="19" y="8" width="2" height="1.6" fill="${c}"/>
    <path d="M8.5 6 C6.5 8.5 7 10 8.5 10.5 C10 10 10.5 8.5 8.5 6Z" fill="${c}"/>`,
  charbon: (c) => `<rect x="15" y="3" width="4" height="18" fill="#d5d2cb" stroke="#1c1f24" stroke-width="1.1"/>
    <rect x="15" y="5" width="4" height="1.6" fill="${c}"/><circle cx="18" cy="1.8" r="1.6" fill="#b9b6b0"/>
    <rect x="3" y="12" width="11" height="9" fill="#fff" stroke="#1c1f24" stroke-width="1.2"/><path d="M2 21 L6 15 L10 21Z" fill="#2f2f33"/>`,
  fioul: (c) => `<rect x="2.5" y="11" width="8" height="10" rx="1" fill="#fff" stroke="#1c1f24" stroke-width="1.2"/>
    <rect x="12.5" y="9" width="9" height="12" rx="1" fill="#fff" stroke="#1c1f24" stroke-width="1.2"/>
    <rect x="2.5" y="14" width="8" height="1.6" fill="${c}"/><rect x="12.5" y="12.5" width="9" height="1.6" fill="${c}"/>
    <path d="M17 2 C15 5 15 6.5 17 7 C19 6.5 19 5 17 2Z" fill="${c}"/>`,
  bioenergies: (c) => `<path d="M3 21 V15 A5 5 0 0 1 13 15 V21Z" fill="${c}" stroke="#1c1f24" stroke-width="1.2"/>
    <rect x="14" y="13" width="7" height="8" fill="#fff" stroke="#1c1f24" stroke-width="1.2"/>
    <path d="M17 3 C21 4 21.5 8 18 10 C16 8.5 15.5 5 17 3Z" fill="#7cbf7f" stroke="#1c1f24" stroke-width=".9"/>`,
};

export function icon(f, size = 22) {
  return `<svg class="pict" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${(P[f] || P.gaz)(COLORS[f] || '#999')}</svg>`;
}
