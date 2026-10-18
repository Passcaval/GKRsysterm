import test from "node:test";
import assert from "node:assert/strict";
import { loginInput, canReview, loginDestination } from "../src/auth.ts";
import { authenticateDemo } from "../src/demo-auth.ts";

test("统一登录只提交登录标识和密码，不提交身份；密码不被裁剪", () => {
  assert.deepEqual(loginInput(" student@example.test ", " pass "), {
    login_type: "email",
    identifier: "student@example.test",
    password: " pass ",
  });
  assert.equal(loginInput("U0000000001", "x").login_type, "user_id");
});

test("账号决定登录权限，错误密码和昵称不能登录，认证身份与管理权限分离", () => {
  const password = "NightVoyageDemo!";
  const student = authenticateDemo(loginInput("U0000000001", password))!;
  const contributor = authenticateDemo(
    loginInput("CONTRIBUTOR@example.test", password),
  )!;
  const reviewer = authenticateDemo(loginInput("U0000000003", password))!;
  const admin = authenticateDemo(loginInput("admin@example.test", password))!;
  assert.equal(loginDestination(student), "/me");
  assert.equal(canReview(student), false);
  assert.equal(canReview(contributor), false);
  assert.equal(contributor.verified, true);
  assert.equal(loginDestination(reviewer), "/admin");
  assert.equal(loginDestination(admin), "/admin/registrations");
  assert.equal(admin.verified, false);
  assert.equal(canReview(null), false);
  assert.equal(authenticateDemo(loginInput("领航员", password)), null);
  assert.equal(
    authenticateDemo(loginInput("admin@example.test", "wrong")),
    null,
  );
  assert.equal(
    authenticateDemo(loginInput("admin@example.test", password + " ")),
    null,
  );
});
