// The answer area for each question type. Every input reports a `Response` (ids and typed
// text, never display positions) or null while the answer is incomplete; Check is enabled
// only when the response is not null. All text is rendered as React text nodes.
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useEffect, useState } from 'react';
import type {
  Labeled,
  MatchingQuestion,
  McQuestion,
  MultiQuestion,
  NumericQuestion,
  OrderingQuestion,
  Question,
  Response,
  TextQuestion,
} from '../domain/types';
import { moveItem } from './ordering';

export interface InputProps<Q extends Question> {
  q: Q;
  /** Display order (ids) chosen when the card was shown: choices, options or items. */
  order: readonly string[];
  disabled: boolean;
  onChange: (r: Response | null) => void;
}

function byOrder(items: readonly Labeled[], order: readonly string[]): Labeled[] {
  const map = new Map(items.map((i) => [i.id, i]));
  return order.flatMap((id) => {
    const i = map.get(id);
    return i ? [i] : [];
  });
}

export function AnswerInput(props: InputProps<Question>) {
  const { q } = props;
  switch (q.type) {
    case 'mc':
      return <McInput {...props} q={q} />;
    case 'multi':
      return <MultiInput {...props} q={q} />;
    case 'numeric':
      return <NumericInput {...props} q={q} />;
    case 'text':
      return <TextInput {...props} q={q} />;
    case 'ordering':
      return <OrderingInput {...props} q={q} />;
    case 'matching':
      return <MatchingInput {...props} q={q} />;
  }
}

function McInput({ q, order, disabled, onChange }: InputProps<McQuestion>) {
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <div className="options" role="group" aria-label="Choices">
      {byOrder(q.choices, order).map((c) => (
        <button
          key={c.id}
          type="button"
          className="option"
          aria-pressed={picked === c.id}
          disabled={disabled}
          onClick={() => {
            setPicked(c.id);
            onChange({ type: 'mc', choice: c.id });
          }}
        >
          {c.text}
        </button>
      ))}
    </div>
  );
}

function MultiInput({ q, order, disabled, onChange }: InputProps<MultiQuestion>) {
  const [picked, setPicked] = useState<string[]>([]);
  function toggle(id: string) {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    setPicked(next);
    onChange(next.length === q.selectCount ? { type: 'multi', choices: next } : null);
  }
  return (
    <div>
      <p className="muted" aria-live="polite">
        Choose {q.selectCount} ({picked.length} chosen)
      </p>
      <div className="options" role="group" aria-label="Choices">
        {byOrder(q.choices, order).map((c) => (
          <button
            key={c.id}
            type="button"
            className="option"
            aria-pressed={picked.includes(c.id)}
            disabled={disabled}
            onClick={() => toggle(c.id)}
          >
            {picked.includes(c.id) ? '✓ ' : ''}
            {c.text}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumericInput({ q, disabled, onChange }: InputProps<NumericQuestion>) {
  const [value, setValue] = useState('');
  return (
    <label className="typed">
      Your answer
      <span className="typed-row">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value);
            onChange(e.target.value.trim() ? { type: 'numeric', input: e.target.value } : null);
          }}
        />
        {q.answer.unit && <span className="unit">{q.answer.unit}</span>}
      </span>
    </label>
  );
}

function TextInput({ disabled, onChange }: InputProps<TextQuestion>) {
  const [value, setValue] = useState('');
  return (
    <label className="typed">
      Your answer
      <input
        type="text"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          setValue(e.target.value);
          onChange(e.target.value.trim() ? { type: 'text', input: e.target.value } : null);
        }}
      />
    </label>
  );
}

function SortableRow({
  item,
  index,
  total,
  selected,
  anySelected,
  disabled,
  onSelect,
  onMove,
  onDrop,
}: {
  item: Labeled;
  index: number;
  total: number;
  selected: boolean;
  anySelected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onMove: (to: number) => void;
  onDrop: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled,
  });
  const label = `Item ${index + 1} of ${total}: ${item.text}`;
  return (
    <li
      ref={setNodeRef}
      className={`order-row${selected ? ' selected' : ''}${isDragging ? ' dragging' : ''}`}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        className="handle"
        aria-label={`Drag: ${label}`}
        disabled={disabled}
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>
      <button
        type="button"
        className="order-text"
        aria-pressed={selected}
        aria-label={`${label}, tap to select`}
        disabled={disabled}
        onClick={onSelect}
      >
        {item.text}
      </button>
      {anySelected && !selected ? (
        <button type="button" className="btn small" disabled={disabled} onClick={onDrop}>
          Move here
        </button>
      ) : (
        <span className="arrows">
          <button
            type="button"
            className="btn small"
            aria-label={`${label}, move up`}
            disabled={disabled || index === 0}
            onClick={() => onMove(index - 1)}
          >
            ▲
          </button>
          <button
            type="button"
            className="btn small"
            aria-label={`${label}, move down`}
            disabled={disabled || index === total - 1}
            onClick={() => onMove(index + 1)}
          >
            ▼
          </button>
        </span>
      )}
    </li>
  );
}

function OrderingInput({ q, order, disabled, onChange }: InputProps<OrderingQuestion>) {
  const [ids, setIds] = useState<string[]>([...order]);
  const [selected, setSelected] = useState<string | null>(null);
  // An ordering answer is always complete: report the starting order straight away.
  useEffect(() => onChange({ type: 'ordering', order: ids }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const items = byOrder(q.items, ids);

  function update(next: string[]) {
    setIds(next);
    setSelected(null);
    onChange({ type: 'ordering', order: next });
  }
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    update(moveItem(ids, ids.indexOf(String(e.active.id)), ids.indexOf(String(e.over.id))));
  }
  return (
    <div>
      <p className="muted">
        Put the steps in order. Drag the ⠿ handle, use ▲ ▼, or tap a row and then “Move here”.
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ol className="order-list">
            {items.map((item, i) => (
              <SortableRow
                key={item.id}
                item={item}
                index={i}
                total={items.length}
                selected={selected === item.id}
                anySelected={selected !== null}
                disabled={disabled}
                onSelect={() => setSelected(selected === item.id ? null : item.id)}
                onMove={(to) => update(moveItem(ids, i, to))}
                onDrop={() => update(moveItem(ids, ids.indexOf(selected as string), i))}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** A pool option: tap it, or drag it onto a prompt (mouse or touch; a tap stays a tap). */
function DraggableOption({
  option,
  disabled,
  onTap,
}: {
  option: Labeled;
  disabled: boolean;
  onTap: () => void;
}) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `option:${option.id}`,
    disabled,
  });
  return (
    <button
      ref={setNodeRef}
      type="button"
      className={isDragging ? 'option dragging' : 'option'}
      data-draggable=""
      style={{ transform: CSS.Translate.toString(transform) }}
      disabled={disabled}
      onClick={onTap}
      {...listeners}
    >
      {option.text}
    </button>
  );
}

function DroppablePrompt({
  prompt,
  pairedText,
  active,
  disabled,
  onTap,
}: {
  prompt: Labeled;
  pairedText: string | undefined;
  active: boolean;
  disabled: boolean;
  onTap: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `prompt:${prompt.id}`, disabled });
  return (
    <li ref={setNodeRef}>
      <button
        type="button"
        className={`match-prompt${active || isOver ? ' active' : ''}`}
        aria-pressed={active}
        disabled={disabled}
        onClick={onTap}
      >
        <span>{prompt.text}</span>
        <span className="match-arrow" aria-hidden="true">
          →
        </span>
        <span className="match-value">
          {pairedText !== undefined ? `${pairedText} (tap to undo)` : '…'}
        </span>
      </button>
    </li>
  );
}

function MatchingInput({ q, order, disabled, onChange }: InputProps<MatchingQuestion>) {
  const [pairs, setPairs] = useState<Record<string, string>>({});
  const [active, setActive] = useState<string | null>(null);
  const used = new Set(Object.values(pairs));
  const pool = byOrder(q.options, order).filter((o) => !used.has(o.id));
  const optionText = (id: string) => q.options.find((o) => o.id === id)?.text ?? id;
  // No keyboard sensor here: Enter/Space on an option must stay a tap. The whole option is
  // draggable, so a touch drag needs a slightly longer hold than the ordering handle: a
  // slow scroll that starts on an option should still scroll.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  function commit(next: Record<string, string>) {
    setPairs(next);
    onChange(
      q.prompts.every((p) => next[p.id] !== undefined) ? { type: 'matching', pairs: next } : null,
    );
  }
  function pair(promptId: string, optionId: string) {
    // Pairing a prompt that already has a match puts the old match back in the pool.
    const next = { ...pairs, [promptId]: optionId };
    commit(next);
    setActive(q.prompts.find((p) => next[p.id] === undefined)?.id ?? null);
  }
  function tapPrompt(id: string) {
    if (pairs[id] !== undefined) {
      const rest = Object.fromEntries(Object.entries(pairs).filter(([k]) => k !== id));
      setActive(id);
      commit(rest);
    } else setActive(active === id ? null : id);
  }
  function tapOption(optionId: string) {
    const target = active ?? q.prompts.find((p) => pairs[p.id] === undefined)?.id;
    if (target) pair(target, optionId);
  }
  function onDragEnd(e: DragEndEvent) {
    const optionId = String(e.active.id).replace(/^option:/, '');
    const promptId = e.over ? String(e.over.id).replace(/^prompt:/, '') : null;
    if (promptId === null || !q.prompts.some((p) => p.id === promptId)) return;
    if (!q.options.some((o) => o.id === optionId) || used.has(optionId)) return;
    pair(promptId, optionId);
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <p className="muted">
        Tap an item, then tap its match (or drag the match onto it). Tap a pair to undo it.
      </p>
      <ul className="match-prompts">
        {q.prompts.map((p) => {
          const paired = pairs[p.id];
          return (
            <DroppablePrompt
              key={p.id}
              prompt={p}
              pairedText={paired !== undefined ? optionText(paired) : undefined}
              active={active === p.id}
              disabled={disabled}
              onTap={() => tapPrompt(p.id)}
            />
          );
        })}
      </ul>
      <div className="options" role="group" aria-label="Options">
        {pool.map((o) => (
          <DraggableOption
            key={o.id}
            option={o}
            disabled={disabled}
            onTap={() => tapOption(o.id)}
          />
        ))}
      </div>
    </DndContext>
  );
}
