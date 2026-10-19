/*
 * A table whose rows can be added, edited in place and deleted. Columns with an
 * `input` are editable; `display` renders a cell outside of editing. onSave and
 * onDelete may throw, and the message is shown under the table.
 */
import { useState } from 'react';
import { EmptyRow, Table } from './ui.jsx';

function CellInput({ column, value, onChange, onKeyDown, autoFocus }) {
  const { input } = column;
  const common = { className: 'cell-input', value: value ?? '', onKeyDown, autoFocus, 'aria-label': column.label };
  if (input.type === 'select') {
    return (
      <select {...common} className="cell-input select" onChange={(event) => onChange(event.target.value)}>
        {input.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return (
    <input
      {...common}
      type={input.type || 'text'}
      placeholder={input.placeholder}
      min={input.min}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export default function EditableTable({
  columns, rows, rowKey = (row) => row.id, newValues, onSave, onDelete,
  canEdit = () => true, canDelete = () => true, deleteWarning, rowActions, actionsWidth = '120px', adding, setAdding,
}) {
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The parent opens the add row (from its panel header); it replaces any other edit.
  const [addingSeen, setAddingSeen] = useState(false);
  if (adding !== addingSeen) {
    setAddingSeen(adding);
    if (adding) {
      setEditingKey(null);
      setDeleting(null);
      setError('');
      setDraft({ ...newValues });
    }
  }
  const isNew = adding;
  const editing = isNew || editingKey !== null;

  function startEdit(row) {
    setAdding(false);
    setDeleting(null);
    setError('');
    setEditingKey(rowKey(row));
    setDraft(Object.fromEntries(columns.filter((column) => column.input).map((column) => [column.key, row[column.key]])));
  }

  function cancel() {
    setEditingKey(null);
    setAdding(false);
    setDraft({});
    setError('');
  }

  async function run(action) {
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (actionError) {
      setError(actionError.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(row) {
    const missing = columns.find((column) => column.input?.required && !String(draft[column.key] ?? '').trim()
      && (row || column.input.onCreate !== false));
    if (missing) {
      setError(missing.label + ' is required.');
      return;
    }
    if (await run(() => onSave(draft, row))) cancel();
  }

  async function confirmDelete() {
    if (await run(() => onDelete(deleting))) setDeleting(null);
  }

  function onKeyDown(row) {
    return (event) => {
      if (event.key === 'Enter') save(row);
      if (event.key === 'Escape') {
        event.stopPropagation();
        cancel();
      }
    };
  }

  function editRow(row) {
    const key = row ? rowKey(row) : 'new';
    const editable = (column) => column.input && (row ? column.input.onEdit !== false : column.input.onCreate !== false);
    let focused = false;
    return (
      <tr key={key} className="is-editing">
        {columns.map((column) => {
          if (!editable(column)) return <td key={column.key} className={column.numeric ? 'is-numeric' : undefined}>{row && column.display ? column.display(row) : row?.[column.key] ?? ''}</td>;
          const autoFocus = !focused;
          focused = true;
          return (
            <td key={column.key}>
              <CellInput
                column={column}
                value={draft[column.key]}
                autoFocus={autoFocus}
                onKeyDown={onKeyDown(row)}
                onChange={(value) => setDraft((current) => ({ ...current, [column.key]: value }))}
              />
            </td>
          );
        })}
        <td>
          <div className="cell-actions">
            <button type="button" className="link link-button" disabled={busy} onClick={() => save(row)}>{row ? 'Save' : 'Add'}</button>
            <button type="button" className="link link-button" disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <>
      <Table
        widths={[...columns.map((column) => column.width || null), actionsWidth]}
        columns={[...columns.map((column) => ({ label: column.label, numeric: column.numeric })), { label: '' }]}
      >
        {rows.map((row) => (rowKey(row) === editingKey ? editRow(row) : (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.key} className={column.numeric ? 'is-numeric' : undefined}>
                {column.display ? column.display(row) : row[column.key]}
              </td>
            ))}
            <td>
              <div className="cell-actions">
                {rowActions && rowActions(row, { busy: busy || editing, run })}
                {canEdit(row) && columns.some((column) => column.input && column.input.onEdit !== false) && (
                  <button type="button" className="link link-button" disabled={busy || editing} onClick={() => startEdit(row)}>Edit</button>
                )}
                {onDelete && canDelete(row) && (
                  <button type="button" className="link link-button" disabled={busy || editing} onClick={() => { setDeleting(row); setError(''); }}>Delete</button>
                )}
              </div>
            </td>
          </tr>
        )))}
        {isNew && editRow(null)}
        {!rows.length && !isNew && <EmptyRow columnCount={columns.length + 1} />}
      </Table>
      {deleting && (
        <div className="confirm-bar" role="alert">
          <span>{deleteWarning ? deleteWarning(deleting) : 'Delete this row?'}</span>
          <button type="button" className="button button-danger" disabled={busy} onClick={confirmDelete}>Delete</button>
          <button type="button" className="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}
