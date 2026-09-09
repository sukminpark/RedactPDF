const configuredBasePath = typeof __APP_BASE_PATH__ === 'undefined' ? '/' : __APP_BASE_PATH__;
const normalizedBasePath = configuredBasePath === '/' ? '' : configuredBasePath.replace(/\/$/u, '');

/** Builds a same-origin URL for an asset regardless of the deployment subpath. */
export function deploymentAssetPath(path: string): string {
  return `${normalizedBasePath}/${path.replace(/^\/+/, '')}`;
}
