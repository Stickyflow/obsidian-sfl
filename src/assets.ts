// --- 3D assets from the vault ---------------------------------------------------
// A `Mesh` names its file as written in the block (`asset: "models/chair.glb"`),
// and a `Scene` names its environment picture the same way. stickyflow.js asks
// the viewer's `resolveAsset` where each name is loaded from; by default only
// web, blob, data and plain relative URLs load, and a vault file is none of
// those. This resolves a name like a link in the note: first relative to the
// note's folder, then to the vault root, and hands back the URL Obsidian serves
// the file under.
import { type App, normalizePath, TFile } from 'obsidian';

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const WEB_SCHEMES = ['http', 'https', 'blob', 'data'];

export function vaultAssetResolver(app: App, sourcePath: string): (asset: string) => string | null {
  const slash = sourcePath.lastIndexOf('/');
  const folder = slash < 0 ? '' : sourcePath.slice(0, slash);

  return (asset: string): string | null => {
    const scheme = SCHEME.exec(asset)?.[1].toLowerCase();
    if (scheme) {
      return WEB_SCHEMES.includes(scheme) ? asset : null;
    }
    const candidates = folder ? [`${folder}/${asset}`, asset] : [asset];
    for (const candidate of candidates) {
      const file = app.vault.getAbstractFileByPath(normalizePath(candidate));
      if (file instanceof TFile) {
        return app.vault.getResourcePath(file);
      }
    }
    return null;
  };
}
