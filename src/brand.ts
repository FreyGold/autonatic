import { addIcon, setIcon } from "obsidian";

/** A compact route-shaped A for Autonatic. */
export const AUTONATIC_MARK_ICON = "autonatic-mark";

// Obsidian custom icons use a 100 × 100 view box; the mark itself is drawn on
// the same 24 × 24 grid as the interface icon set.
const AUTONATIC_MARK_SVG = `
  <g transform="scale(4.1666667)">
    <rect x="2" y="2" width="20" height="20" rx="5.25" fill="currentColor" />
    <path d="M6.8 16.8 11.05 7.2c.38-.87 1.52-.87 1.9 0l4.25 9.6M8.65 13.35h6.7" fill="none" stroke="white" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round" />
  </g>
`;

// The display lettering is outlined so the identity remains identical on every
// Obsidian installation. Letterforms are based on Instrument Sans (OFL-1.1)
// at 95% width and weight 640.
const AUTONATIC_WORDMARK_GLYPHS = [
  [0, "M23 0L261 720L376 720L158 0ZM516 0L299 720L421 720L658 0ZM152 278L521 278L521 170L152 170Z"],
  [651.59, "M214 -10Q165 -10 129 11Q93 32 74 69Q55 106 55 153L55 510L189 510L189 181Q189 139 209 118.5Q229 98 266 98Q299 98 324.5 113.5Q350 129 365.5 158Q381 187 381 223L394 109Q370 56 324 23Q278 -10 214 -10ZM383 0L383 115L381 115L381 510L514 510L514 0Z"],
  [1218.755, "M283 -11Q192 -11 148 33Q104 77 104 165L104 622L238 673L238 162Q238 128 256 112Q274 96 314 96Q328 96 340.5 98.5Q353 101 365 105L365 2Q352 -3 330.5 -7Q309 -11 283 -11ZM14 406L14 510L364 510L364 406Z"],
  [1593.654, "M285 -10Q208 -10 148.5 24Q89 58 56.5 118.5Q24 179 24 257Q24 336 57 395Q90 454 148.5 487Q207 520 285 520Q363 520 422 487Q481 454 513.5 395Q546 336 546 257Q546 179 513.5 118.5Q481 58 422 24Q363 -10 285 -10ZM285 96Q320 96 347.5 115Q375 134 391.5 170Q408 206 408 258Q408 334 373.5 374Q339 414 285 414Q232 414 197.5 373.5Q163 333 163 258Q163 206 179 170Q195 134 222.5 115Q250 96 285 96Z"],
  [2163.32, "M61 0L61 510L191 510L191 395L194 395L194 0ZM394 0L394 329Q394 370 373 391Q352 412 312 412Q277 412 250.5 396.5Q224 381 209 353Q194 325 194 287L180 400Q205 456 251.5 488Q298 520 365 520Q442 520 484.5 475.5Q527 431 527 356L527 0Z"],
  [2735.819, "M358 0Q353 20 350.5 44Q348 68 348 99L344 99L344 349Q344 384 324.5 403Q305 422 265 422Q227 422 204.5 406.5Q182 391 177 360L52 360Q59 430 116 475Q173 520 271 520Q371 520 424 473.5Q477 427 477 338L477 99Q477 76 479.5 51Q482 26 490 0ZM193 -10Q122 -10 80 27.5Q38 65 38 129Q38 197 84.5 237.5Q131 278 218 295L369 328L369 243L251 219Q209 211 189.5 193Q170 175 170 145Q170 118 188 104Q206 90 238 90Q282 90 313 114Q344 138 344 172L357 96Q337 44 295 17Q253 -10 193 -10Z"],
  [3242.584, "M283 -11Q192 -11 148 33Q104 77 104 165L104 622L238 673L238 162Q238 128 256 112Q274 96 314 96Q328 96 340.5 98.5Q353 101 365 105L365 2Q352 -3 330.5 -7Q309 -11 283 -11ZM14 406L14 510L364 510L364 406Z"],
  [3629.117, "M61 0L61 510L194 510L194 0ZM56 588L56 733L199 733L199 588Z"],
  [3882.033, "M273 -10Q200 -10 144 23.5Q88 57 56 116.5Q24 176 24 256Q24 334 56 394Q88 454 144 487Q200 520 274 520Q336 520 385.5 496Q435 472 466 429Q497 386 504 326L379 326Q370 370 342.5 392Q315 414 277 414Q241 414 216 396Q191 378 176.5 342.5Q162 307 162 256Q162 205 176.5 169Q191 133 216.5 114.5Q242 96 276 96Q315 96 342.5 118Q370 140 378 184L505 184Q497 125 465 81.5Q433 38 383.5 14Q334 -10 273 -10Z"],
] as const;

function renderAutonaticWordmark(parent: HTMLElement): void {
  const wordmark = parent.createEl("h2", { cls: "autonatic-wordmark", attr: { "aria-label": "Autonatic" } });
  const svg = wordmark.createSvg("svg", {
    cls: "autonatic-wordmark-art",
    attr: { viewBox: "0 0 4408.023 744", "aria-hidden": "true", focusable: "false" },
  });
  const glyphs = svg.createSvg("g", { attr: { transform: "translate(0 733) scale(1 -1)" } });
  for (const [x, d] of AUTONATIC_WORDMARK_GLYPHS) {
    glyphs.createSvg("path", { attr: { d, transform: `translate(${x} 0)` } });
  }
}

export function registerAutonaticIcons(): void {
  addIcon(AUTONATIC_MARK_ICON, AUTONATIC_MARK_SVG);
}

/** Shared lockup used in the workspace and settings. */
export function renderAutonaticBrand(parent: HTMLElement, version?: string): HTMLElement {
  const identity = parent.createDiv({ cls: "autonatic-brand" });
  const mark = identity.createSpan({ cls: "autonatic-brand-mark", attr: { "aria-hidden": "true" } });
  setIcon(mark, AUTONATIC_MARK_ICON);
  renderAutonaticWordmark(identity);
  if (version) identity.createSpan({ text: `v${version}`, cls: "autonatic-version" });
  return identity;
}
