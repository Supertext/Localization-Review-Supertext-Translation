import pkg from '../../package.json';

/** The proxy's version, from apps/proxy/package.json (an official version file, see docs/DEVELOPER.md → Releasing). */
export const APP_VERSION: string = pkg.version;
export const APP_REPO = 'https://github.com/Supertext/Localization-Review-Supertext-Translation';

export function appReleaseUrl(): string | null {
  return /^\d+\.\d+\.\d+$/.test(APP_VERSION) ? `${APP_REPO}/releases/tag/v${APP_VERSION}` : null;
}
