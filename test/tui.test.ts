import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  load: vi.fn(),
  login: vi.fn(),
  edit: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../src/ui.ts", () => ({ select: mocks.select }));
vi.mock("../src/core/registry.ts", () => ({
  load: mocks.load,
  command: (profile: { slug: string }) => `codex-${profile.slug}`,
}));
vi.mock("../src/commands/login.ts", () => ({ login: mocks.login }));
vi.mock("../src/commands/edit.ts", () => ({ edit: mocks.edit }));
vi.mock("../src/commands/remove.ts", () => ({ remove: mocks.remove }));

const { run } = await import("../src/tui.ts");
const profile = { slug: "student", label: "Student", createdAt: "2026-01-01" };

afterEach(() => vi.resetAllMocks());

describe("interactive profile management", () => {
  it.each([
    [0, "login"],
    [1, "edit"],
    [2, "remove"],
  ] as const)("routes management action %i to %s for the chosen slug", async (action, method) => {
    mocks.load.mockResolvedValue([profile]);
    mocks.select
      .mockResolvedValueOnce({ ok: true, index: 3 })
      .mockResolvedValueOnce({ ok: true, index: 0 })
      .mockResolvedValueOnce({ ok: true, index: action })
      .mockResolvedValueOnce({ ok: false });

    await expect(run()).resolves.toBe(0);
    expect(mocks[method]).toHaveBeenCalledWith("student", ...(method === "remove" ? [] : [{}]));
    expect(mocks.select.mock.calls[0]?.[0]).toContain("Manage profiles");
    expect(mocks.select.mock.calls[2]?.[0]).toContain("Sign in with another account");
  });
});
