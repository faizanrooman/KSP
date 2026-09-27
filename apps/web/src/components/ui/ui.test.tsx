/** Regression tests for UI primitives fixed during the E2E / accessibility pass. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Card, ConfirmDialog, EmptyState, Field, Input, Modal, ProgressBar, Tabs, Textarea } from './index';

afterEach(cleanup);

describe('Modal focus', () => {
  it('keeps a child autoFocus (reason fields) instead of moving focus to the Close button', () => {
    render(
      <Modal open title="Reject AI result" onClose={() => undefined}>
        <Textarea aria-label="Reason" autoFocus />
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: 'Reason' })).toHaveFocus();
  });

  it('focuses the first form field when nothing requested focus', () => {
    render(
      <ConfirmDialog open title="Place legal hold" message="Why?" requireReason onConfirm={() => undefined} onCancel={() => undefined} />,
    );
    expect(screen.getByRole('textbox', { name: /Reason/ })).toHaveFocus();
  });

  it('falls back to the first focusable control', () => {
    render(<ConfirmDialog open title="Revoke" message="Sure?" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  });
});

describe('Field', () => {
  it('associates the label with a child control that has no id', () => {
    render(
      <Field label="Reason" hint="At least 5 characters">
        <Textarea />
      </Field>,
    );
    const box = screen.getByRole('textbox', { name: 'Reason' });
    expect(box).toHaveAccessibleDescription('At least 5 characters');
  });

  it('keeps an explicit id/htmlFor and marks errors', () => {
    render(
      <Field label="Name" htmlFor="n" error="Required">
        <Input id="n" />
      </Field>,
    );
    const box = screen.getByRole('textbox', { name: 'Name' });
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription('Required');
  });
});

describe('Card / EmptyState / ProgressBar', () => {
  it('names a card region by its title', () => {
    render(<Card title="Fixity">x</Card>);
    expect(screen.getByRole('region', { name: 'Fixity' })).toBeInTheDocument();
  });

  it('renders a heading when asked (status pages)', () => {
    render(<EmptyState heading="h1" title="Access denied" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Access denied' })).toBeInTheDocument();
  });

  it('expects a 0..1 fraction', () => {
    act(() => {
      render(<ProgressBar value={0.42} label="Analysis progress" />);
    });
    expect(screen.getByRole('progressbar', { name: 'Analysis progress' })).toHaveAttribute('aria-valuenow', '42');
  });
});

describe('Tabs keyboard navigation', () => {
  it('advances from the focused tab even when the selection has not been committed yet (deferred router updates)', () => {
    const changes: string[] = [];
    // `value` never changes: models a selection committed later (transition / lazy tab content still loading).
    render(<Tabs tabs={[{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }]} value="a" onChange={(v) => changes.push(v)} />);
    const tabs = screen.getAllByRole('tab');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);
    expect(changes).toEqual(['b', 'c', 'a']);
  });
});
