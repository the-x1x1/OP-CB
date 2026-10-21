import { Button } from '@worldview/ui';
import { useActions } from '../store/store.js';
import type { ImportedFile } from './imported-files.js';

/**
 * The files drawn on the map this session (imported-files.ts): each with its colour, how many
 * shapes, and what the reader left out; shown or hidden, flown to or removed. Nothing here is
 * saved — closing the app forgets them.
 */
export function ImportedFilesCard({ files }: { files: readonly ImportedFile[] }) {
  const actions = useActions();
  if (files.length === 0) return null;
  return (
    <section className="wv-imported" aria-label="Files on the map">
      <div className="wv-imported__head">
        <span className="wv-caps">Files on the map</span>
        <Button size="sm" variant="ghost" icon="upload" onClick={() => actions.requestImport()}>
          Add
        </Button>
      </div>
      <ul className="wv-imported__list">
        {files.map((f) => (
          <li key={f.id} className="wv-imported__row" title={f.issues.length ? f.issues.join('\n') : undefined}>
            <label className="wv-imported__name">
              <input
                type="checkbox"
                checked={f.visible}
                onChange={(e) => actions.setImportedVisible(f.id, e.currentTarget.checked)}
                aria-label={`Show ${f.name}`}
              />
              <span className="wv-imported__swatch" style={{ background: f.color }} aria-hidden="true" />
              <span className="wv-imported__file">{f.name}</span>
              <span className="wv-ctx-muted wv-num">
                {f.shapes.length.toLocaleString('en-US')}
                {f.issues.length ? ' · some left out' : ''}
              </span>
            </label>
            <Button
              size="sm"
              variant="ghost"
              icon="target"
              aria-label={`Go to ${f.name}`}
              onClick={() => actions.flyToImported(f.id)}
            />
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              aria-label={`Remove ${f.name}`}
              onClick={() => actions.removeImported(f.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
