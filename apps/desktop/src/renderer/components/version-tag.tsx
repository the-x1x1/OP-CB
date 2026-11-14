import { useAppSlice } from '../store/store.js';
import type { AppInfo } from '../store/types.js';

/**
 * The running build, under the wordmark at the top left (operator, 2026-11-13: "which version
 * its running … updates each time the app is updated"). Read from `app.info` at start, which is
 * the installed build's own version and commit, so after an update and restart it is the new one.
 * The commit is shown too: a test build of a branch carries the same version number as the
 * release it follows, and only the commit tells them apart.
 */
export function versionLabel(info: Pick<AppInfo, 'version' | 'commit' | 'channel'> | null | undefined): {
  text: string;
  title: string;
} | null {
  if (!info?.version) return null;
  const commit = /^[0-9a-f]{7,40}$/i.test(info.commit ?? '') ? info.commit.slice(0, 8).toLowerCase() : '';
  const channel = info.channel && info.channel !== 'stable' ? ` ${info.channel}` : '';
  return {
    text: `v${info.version}${channel}${commit ? ` · ${commit}` : ''}`,
    title: `OP-CB ${info.version}${channel}${commit ? `, build ${info.commit}` : ''}`,
  };
}

export function VersionTag({ className }: { className?: string }) {
  const info = useAppSlice((s) => s.session.appInfo);
  const label = versionLabel(info);
  if (!label) return null;
  return (
    <span className={`wv-version-tag${className ? ` ${className}` : ''}`} title={label.title}>
      {label.text}
    </span>
  );
}
