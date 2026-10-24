'use client';

import { useState, type HTMLAttributes, type ReactNode } from 'react';
import { move, ROW_DETAIL_LABELS, ROW_DETAILS, TOPBAR_LABELS, type TopbarItem } from '../lib/layout';
import type { Stage } from '../lib/schemas';
import { Dialog } from './dialog';
import { Icon } from './pipeline';
import { Switch } from './settings-controls';

/** One item in edit mode: it wiggles, and "−" on its corner removes it. */
export function Wiggle({
  item,
  label,
  onRemove,
  children,
  ...drag
}: {
  item: string;
  label: string;
  onRemove: () => void;
  children: ReactNode;
} & Pick<
  HTMLAttributes<HTMLSpanElement>,
  'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDrop'
>) {
  return (
    <span className="wiggle" data-testid="editable-item" data-item={item} {...drag}>
      <button type="button" className="wiggle-remove" aria-label={`Remove ${label}`} onClick={onRemove}>
        −
      </button>
      {children}
    </span>
  );
}

/** A row of wiggling items: drag or the arrows reorder, "−" removes. */
export function EditableRow<T extends string>({
  items,
  label,
  render,
  onChange,
  onOpen,
}: {
  items: T[];
  label: (item: T) => string;
  render: (item: T) => ReactNode;
  onChange: (items: T[]) => void;
  onOpen?: (item: T) => void;
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) => (
        <Wiggle
          key={item}
          item={item}
          label={label(item)}
          onRemove={() => onChange(items.filter((x) => x !== item))}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', item); // Firefox starts a drag only with data
            setDragged(i);
          }}
          onDragEnd={() => setDragged(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragged !== null) onChange(move(items, dragged, i));
          }}
        >
          {onOpen ? (
            <button
              type="button"
              className="wiggle-body"
              onClick={() => onOpen(item)}
              aria-label={`Edit ${label(item)}`}
            >
              {render(item)}
            </button>
          ) : (
            <span className="wiggle-body">{render(item)}</span>
          )}
          <span className="wiggle-move">
            <button
              type="button"
              aria-label={`Move ${label(item)} left`}
              disabled={i === 0}
              onClick={() => onChange(move(items, i, i - 1))}
            >
              ‹
            </button>
            <button
              type="button"
              aria-label={`Move ${label(item)} right`}
              disabled={i === items.length - 1}
              onClick={() => onChange(move(items, i, i + 1))}
            >
              ›
            </button>
          </span>
        </Wiggle>
      ))}
    </>
  );
}

export function Chip({ icon, label, locked }: { icon: string; label: string; locked?: boolean }) {
  return (
    <span className={`stage-chip${locked ? ' locked' : ''}`}>
      <Icon kind={icon} />
      {label}
      {locked && <span className="sr-only"> (fixed)</span>}
    </span>
  );
}

/** "+ Add": what is not on the screen now, to put back, and the switches for each row's details. */
export function AddSheet({
  topbar,
  spare,
  deploy,
  guardian,
  hiddenDetails,
  onAddTopbar,
  onAddStage,
  onEditStage,
  onNewStage,
  onPipeline,
  onToggleDetail,
  onClose,
}: {
  /** Top bar items not shown. */
  topbar: TopbarItem[];
  /** Stages not in the pipeline. */
  spare: Stage[];
  deploy: boolean;
  guardian: boolean;
  hiddenDetails: readonly (typeof ROW_DETAILS)[number][];
  onAddTopbar: (item: TopbarItem) => void;
  onAddStage: (id: string) => void;
  onEditStage: (stage: Stage) => void;
  onNewStage: () => void;
  onPipeline: (patch: { deploy?: boolean; guardian?: boolean }) => void;
  onToggleDetail: (detail: (typeof ROW_DETAILS)[number]) => void;
  onClose: () => void;
}) {
  return (
    <Dialog label="Add" onClose={onClose} testId="add-sheet">
      <h2>Add</h2>
      <h3>Top bar</h3>
      {topbar.length === 0 && <p className="muted small">Everything is in the top bar.</p>}
      <div className="add-grid">
        {topbar.map((item) => (
          <button key={item} type="button" className="ghost" onClick={() => onAddTopbar(item)}>
            + {TOPBAR_LABELS[item]}
          </button>
        ))}
      </div>
      <h3>Pipeline</h3>
      <div className="add-grid">
        {spare.map((s) => (
          <span key={s.id} className="add-stage">
            <button type="button" className="ghost" onClick={() => onAddStage(s.id)}>
              + <Chip icon={s.icon} label={s.title} />
            </button>
            <button
              type="button"
              className="ghost small"
              onClick={() => onEditStage(s)}
              aria-label={`Edit ${s.title}`}
            >
              Edit
            </button>
          </span>
        ))}
        {!deploy && (
          <button type="button" className="ghost" onClick={() => onPipeline({ deploy: true })}>
            + <Chip icon="deploying" label="Deploy watch" />
          </button>
        )}
        {!guardian && (
          <button type="button" className="ghost" onClick={() => onPipeline({ guardian: true })}>
            + <Chip icon="guardian" label="Production Guardian" />
          </button>
        )}
        <button type="button" onClick={onNewStage} data-testid="new-stage">
          + New stage
        </button>
      </div>
      <h3>On each row</h3>
      {ROW_DETAILS.map((detail) => (
        <Switch
          key={detail}
          label={ROW_DETAIL_LABELS[detail]}
          checked={!hiddenDetails.includes(detail)}
          onChange={() => onToggleDetail(detail)}
        />
      ))}
      <button type="button" className="ghost" onClick={onClose}>
        Done
      </button>
    </Dialog>
  );
}

/** ✕ with changes: Approve, Discard or Keep editing. */
export function CloseDialog({
  readOnly,
  saving,
  error,
  onApprove,
  onDiscard,
  onKeepEditing,
}: {
  readOnly: boolean;
  saving: boolean;
  error: string | null;
  onApprove: () => void;
  onDiscard: () => void;
  onKeepEditing: () => void;
}) {
  return (
    <Dialog label="Apply the changes?" onClose={onKeepEditing} testId="close-dialog">
      <h2>Apply these changes to your dashboard?</h2>
      <p className="muted">
        Approve saves the layout and the pipeline; the PR loop uses the new pipeline from its next step.
      </p>
      {readOnly && (
        <p className="warning small">Demo data is read-only: connect a server to apply changes.</p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
      <div className="row-actions">
        <button type="button" disabled={readOnly || saving} onClick={onApprove} data-testid="editor-approve">
          {saving ? 'Applying…' : 'Approve'}
        </button>
        <button type="button" className="ghost" onClick={onDiscard} data-testid="editor-discard">
          Discard
        </button>
        <button type="button" className="ghost" onClick={onKeepEditing}>
          Keep editing
        </button>
      </div>
    </Dialog>
  );
}
