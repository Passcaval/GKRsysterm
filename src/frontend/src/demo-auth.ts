import type { LoginInput } from "./auth.ts";
import type { User } from "./types.ts";

// Public fixtures for offline demonstration only; never used in HTTP mode.
const accounts: { email: string; userId: string; user: User }[] = [
  {
    email: "student@example.test",
    userId: "U0000000001",
    user: {
      id: "demo-student",
      name: "探索者",
      role: "student",
      verified: false,
    },
  },
  {
    email: "contributor@example.test",
    userId: "U0000000002",
    user: {
      id: "demo-contributor",
      name: "引路人",
      role: "contributor",
      verified: true,
    },
  },
  {
    email: "reviewer@example.test",
    userId: "U0000000003",
    user: {
      id: "demo-reviewer",
      name: "守灯人",
      role: "reviewer",
      verified: false,
    },
  },
  {
    email: "admin@example.test",
    userId: "U0000000004",
    user: { id: "demo-admin", name: "领航员", role: "admin", verified: false },
  },
];

export function authenticateDemo(input: LoginInput): User | null {
  if (input.password !== "NightVoyageDemo!") return null;
  const account = accounts.find((item) =>
    input.login_type === "email"
      ? item.email === input.identifier.toLowerCase()
      : item.userId === input.identifier,
  );
  return account
    ? {
        ...account.user,
        userId: account.userId,
        email: account.email,
        emailVerified: false,
        permissions:
          account.user.role === "admin"
            ? ["registration:review", "verification:review", "content:review"]
            : account.user.role === "reviewer"
              ? ["content:review"]
              : [],
      }
    : null;
}
