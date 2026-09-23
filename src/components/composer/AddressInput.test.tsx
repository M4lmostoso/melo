import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { AddressInput } from "./AddressInput";

// Mock the contacts search
const mockSearchContacts = vi.fn().mockResolvedValue([]);
vi.mock("@/services/db/contacts", () => ({
  searchContacts: (...args: unknown[]) => mockSearchContacts(...args),
}));

describe("AddressInput debounce behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSearchContacts.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should not search immediately on input change", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );

    const input = getByRole("textbox", { name: "To" });
    fireEvent.change(input, { target: { value: "jo" } });

    // Should NOT have searched yet (debounce not elapsed)
    expect(mockSearchContacts).not.toHaveBeenCalled();
  });

  it("should search after debounce period", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );

    const input = getByRole("textbox", { name: "To" });
    fireEvent.change(input, { target: { value: "jo" } });

    // Advance past 200ms debounce
    await vi.advanceTimersByTimeAsync(250);
    expect(mockSearchContacts).toHaveBeenCalledWith("jo", 5);
  });

  it("should not search when input is too short", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );

    const input = getByRole("textbox", { name: "To" });
    fireEvent.change(input, { target: { value: "j" } });

    await vi.advanceTimersByTimeAsync(250);
    expect(mockSearchContacts).not.toHaveBeenCalled();
  });

  it("should debounce rapid keystrokes", async () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );

    const input = getByRole("textbox", { name: "To" });

    // Simulate rapid typing — each keystroke resets the debounce
    fireEvent.change(input, { target: { value: "jo" } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(input, { target: { value: "joh" } });
    await vi.advanceTimersByTimeAsync(100);
    fireEvent.change(input, { target: { value: "john" } });

    // At this point 200ms haven't passed since the last change
    expect(mockSearchContacts).not.toHaveBeenCalled();

    // Now advance past debounce from last keystroke
    await vi.advanceTimersByTimeAsync(250);
    expect(mockSearchContacts).toHaveBeenCalledTimes(1);
    expect(mockSearchContacts).toHaveBeenCalledWith("john", 5);
  });
});

describe("AddressInput recipient chips", () => {
  it("shows the display name, keeping the full address in the title", () => {
    const { getByTitle } = render(
      <AddressInput
        label="To"
        addresses={['"Melki, Benjamin" <benjamin.melki@suez.com>']}
        onChange={vi.fn()}
      />,
    );
    const chip = getByTitle('"Melki, Benjamin" <benjamin.melki@suez.com>');
    expect(chip.textContent).toContain("Melki, Benjamin");
    expect(chip.textContent).not.toContain('"');
  });

  it("falls back to the bare address when there is no display name", () => {
    const { getByTitle } = render(
      <AddressInput label="To" addresses={["plain@y.com"]} onChange={vi.fn()} />,
    );
    expect(getByTitle("plain@y.com").textContent).toContain("plain@y.com");
  });

  it("does not commit a chip on a comma typed inside a display name", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );
    const input = getByRole("textbox", { name: "To" });
    fireEvent.change(input, { target: { value: "Melki" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still commits on a comma once the input holds an address", () => {
    const onChange = vi.fn();
    const { getByRole } = render(
      <AddressInput label="To" addresses={[]} onChange={onChange} />,
    );
    const input = getByRole("textbox", { name: "To" });
    fireEvent.change(input, { target: { value: "Melki, Benjamin <b@suez.com>" } });
    fireEvent.keyDown(input, { key: "," });
    expect(onChange).toHaveBeenCalledWith(["Melki, Benjamin <b@suez.com>"]);
  });
});
