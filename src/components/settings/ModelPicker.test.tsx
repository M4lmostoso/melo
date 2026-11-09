import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const catalog = {
  provider: "gemini",
  fallback: false,
  fetchedAt: Date.now(),
  models: [
    { id: "gemma-4-31b-it", label: "Gemma 4 31B" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
  ],
};

vi.mock("@/services/ai/modelCatalog", () => ({
  getModelCatalog: vi.fn(async () => catalog),
}));

import { ModelPicker, filterModels } from "./ModelPicker";

describe("ModelPicker", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the WHOLE catalog on open even though the field already holds a model", async () => {
    render(
      <ModelPicker provider="gemini" value="gemini-3.6-flash" onChange={() => {}} onCommit={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText(/3 /)).toBeTruthy());

    fireEvent.focus(screen.getByRole("combobox"));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toHaveLength(3);
    expect(options.join()).toContain("Gemma 4 31B");
  });

  it("filters only once the user types, and picking commits the id", async () => {
    const onCommit = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelPicker provider="gemini" value="gemini-3.6-flash" onChange={onChange} onCommit={onCommit} />,
    );
    await waitFor(() => expect(screen.getByText(/3 /)).toBeTruthy());
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gemma" } });
    rerender(<ModelPicker provider="gemini" value="gemma" onChange={onChange} onCommit={onCommit} />);

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    fireEvent.mouseDown(options[0]!);
    expect(onCommit).toHaveBeenCalledWith("gemma-4-31b-it");
  });

  it("filterModels matches id or label, case-insensitive; empty query = everything", () => {
    expect(filterModels(catalog.models, null)).toHaveLength(3);
    expect(filterModels(catalog.models, "  ")).toHaveLength(3);
    expect(filterModels(catalog.models, "FLASH").map((m) => m.id)).toEqual(["gemini-3.8-flash", "gemini-3.6-flash"]);
    expect(filterModels(catalog.models, "31B").map((m) => m.id)).toEqual(["gemma-4-31b-it"]);
  });
});
