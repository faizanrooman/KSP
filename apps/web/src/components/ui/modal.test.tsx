/** Regression tests for dialog behaviour fixed in the UI/UX audit (docs/UI-AUDIT-A.md). */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { titleCase } from '@/lib/format';
import { Field, Input, Modal } from './index';

afterEach(cleanup);

/** A dialog whose form state lives in the parent and whose onClose is an inline arrow (the common pattern). */
function ParentOwnedForm() {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open details</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Details">
        <Field label="Title"><Input value={a} onChange={(e) => setA(e.target.value)} /></Field>
        <Field label="Category"><Input value={b} onChange={(e) => setB(e.target.value)} /></Field>
      </Modal>
    </>
  );
}

describe('Modal (audit A)', () => {
  it('keeps focus in the field being typed into when the parent re-renders (UXA-01)', () => {
    render(<ParentOwnedForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    const category = screen.getByRole('textbox', { name: 'Category' });
    category.focus();
    fireEvent.change(category, { target: { value: 'P' } });
    fireEvent.change(category, { target: { value: 'PA' } });
    expect(category).toHaveFocus();
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('');
  });

  it('locks page scroll while open and restores it on close (UXA-02)', () => {
    document.body.style.overflow = 'auto';
    render(<ParentOwnedForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Open details' }));
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.body.style.overflow).toBe('auto');
  });

  it('returns focus to the opener even when a child used autoFocus (UXA-03)', () => {
    function WithAutoFocus() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>Link to case</button>
          <Modal open={open} onClose={() => setOpen(false)} title="Link">
            <Field label="Search"><Input autoFocus /></Field>
          </Modal>
        </>
      );
    }
    render(<WithAutoFocus />);
    const opener = screen.getByRole('button', { name: 'Link to case' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('textbox', { name: 'Search' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

  it('Escape closes only the top-most of two nested dialogs (UXA-04)', () => {
    const closed: string[] = [];
    render(
      <Modal open onClose={() => closed.push('outer')} title="Outer">
        <p>outer</p>
        <Modal open onClose={() => closed.push('inner')} title="Inner">
          <p>inner</p>
        </Modal>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closed).toEqual(['inner']);
  });
});

describe('titleCase', () => {
  it('keeps acronyms upper-case (UXA-07)', () => {
    expect(titleCase('AI_RESULT_APPROVED')).toBe('AI Result Approved');
    expect(titleCase('ANPR')).toBe('ANPR');
    expect(titleCase('PENDING_REVIEW')).toBe('Pending Review');
  });
});
