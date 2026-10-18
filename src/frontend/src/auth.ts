import { hasPermission } from "./types.ts";
import type { User } from "./types.ts";

export interface LoginInput {
  login_type: "email" | "user_id";
  identifier: string;
  password: string;
}

// Identifier type is unrelated to account privileges. Never accept a role here.
export function loginInput(identifier: string, password: string): LoginInput {
  const value = identifier.trim();
  return {
    login_type: value.includes("@") ? "email" : "user_id",
    identifier: value,
    password,
  };
}

export function canReview(user: User | null): boolean {
  return hasPermission(user, "content:review");
}

export function loginDestination(user: User): string {
  return hasPermission(user, "registration:review")
    ? "/admin/registrations"
    : canReview(user)
      ? "/admin"
      : "/me";
}
