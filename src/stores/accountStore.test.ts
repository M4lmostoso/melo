import { describe, it, expect, beforeEach } from "vitest";
import { useAccountStore, type Account } from "./accountStore";

const mockAccount: Account = {
  id: "acc-1",
  email: "test@gmail.com",
  displayName: "Test User",
  avatarUrl: null,
  isActive: true,
};

const mockAccount2: Account = {
  id: "acc-2",
  email: "work@gmail.com",
  displayName: "Work Account",
  avatarUrl: null,
  isActive: true,
};

describe("accountStore", () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,
    });
  });

  it("should start with no accounts", () => {
    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(0);
    expect(state.activeAccountId).toBeNull();
  });

  it("should add an account and set it as active", () => {
    useAccountStore.getState().addAccount(mockAccount);
    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(1);
    expect(state.activeAccountId).toBe("acc-1");
  });

  it("should not override active account when adding second account", () => {
    useAccountStore.getState().addAccount(mockAccount);
    useAccountStore.getState().addAccount(mockAccount2);
    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(2);
    expect(state.activeAccountId).toBe("acc-1");
  });

  it("should switch active account", () => {
    useAccountStore.getState().addAccount(mockAccount);
    useAccountStore.getState().addAccount(mockAccount2);
    useAccountStore.getState().setActiveAccount("acc-2");
    expect(useAccountStore.getState().activeAccountId).toBe("acc-2");
  });

  it("should remove account and update active if needed", () => {
    useAccountStore.getState().addAccount(mockAccount);
    useAccountStore.getState().addAccount(mockAccount2);
    useAccountStore.getState().removeAccount("acc-1");

    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(1);
    expect(state.activeAccountId).toBe("acc-2");
  });

  it("should set active to null when last account removed", () => {
    useAccountStore.getState().addAccount(mockAccount);
    useAccountStore.getState().removeAccount("acc-1");

    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(0);
    expect(state.activeAccountId).toBeNull();
  });

  it("should set accounts from array", () => {
    useAccountStore.getState().setAccounts([mockAccount, mockAccount2]);
    const state = useAccountStore.getState();
    expect(state.accounts).toHaveLength(2);
    expect(state.activeAccountId).toBe("acc-1");
  });

  it("should use the default account as active fallback when no valid restored id", () => {
    useAccountStore.getState().hydrateDefaultAccount("acc-2");
    useAccountStore.getState().setAccounts([mockAccount, mockAccount2], null);
    expect(useAccountStore.getState().activeAccountId).toBe("acc-2");
  });

  it("should prefer a valid restored id over the default account", () => {
    useAccountStore.getState().hydrateDefaultAccount("acc-2");
    useAccountStore.getState().setAccounts([mockAccount, mockAccount2], "acc-1");
    expect(useAccountStore.getState().activeAccountId).toBe("acc-1");
  });

  it("should drop a stale default account that no longer exists", () => {
    useAccountStore.getState().hydrateDefaultAccount("acc-gone");
    useAccountStore.getState().setAccounts([mockAccount, mockAccount2], null);
    const state = useAccountStore.getState();
    expect(state.defaultAccountId).toBeNull();
    expect(state.activeAccountId).toBe("acc-1");
  });

  it("should clear the default account when it is removed", () => {
    useAccountStore.getState().addAccount(mockAccount);
    useAccountStore.getState().addAccount(mockAccount2);
    useAccountStore.getState().setDefaultAccount("acc-2");
    expect(useAccountStore.getState().defaultAccountId).toBe("acc-2");
    useAccountStore.getState().removeAccount("acc-2");
    expect(useAccountStore.getState().defaultAccountId).toBeNull();
  });
});
