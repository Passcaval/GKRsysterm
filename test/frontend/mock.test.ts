import test from "node:test";
import assert from "node:assert/strict";
import { loadApi, installStorage } from "./helpers.ts";
test("Mock纵向闭环：申请幂等、身份占用、独立审核、双标识登录、版本画像、推荐任务/反馈及账号隔离", async () => {
  installStorage();
  const { api, cleanup } = await loadApi("mock");
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const original = await api.bootstrap();
    await api.logout();
    const input = {
      nickname: "𠀀Alice".slice(0, 6),
      email: "New.User+test@Example.com",
      password: "mock-password-with spaces ",
      evidenceText: "这是一份明确的测试注册说明，不是真实身份资料。",
      evidenceAudio: new File(["fixture voice"], "test.ogg", {
        type: "audio/ogg",
      }),
    };
    input.nickname = "中Ab文";
    const receipt = await api.register(input, "register-one");
    const replay = await api.register(input, "register-one");
    assert.equal(replay.applicationId, receipt.applicationId);
    assert.equal((await api.bootstrap()).user, null);
    await assert.rejects(
      api.register(
        { ...input, evidenceText: "different evidence" },
        "register-one",
      ),
      (e: any) => e.status === 409 && e.code === "IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      api.register({ ...input, nickname: "中ab文" }, "register-two"),
      (e: any) => e.status === 409,
    );
    await assert.rejects(
      api.application(receipt.applicationId, "wrong-token"),
      (e: any) => e.status === 404,
    );
    assert.equal(
      (await api.application(receipt.applicationId, receipt.statusToken))
        .status,
      "pending",
    );
    await assert.rejects(
      api.login(input.email, input.password, "email"),
      (e: any) => e.status === 401,
    );
    await api.login("reviewer@example.test", "NightVoyageDemo!");
    await assert.rejects(api.registrationQueue(), (e: any) => e.status === 403);
    await api.login("admin@example.test", "NightVoyageDemo!");
    const queue = await api.registrationQueue();
    assert.ok(
      queue.items.some((a: any) => a.applicationId === receipt.applicationId),
    );
    const detail = await api.applicationDetail(receipt.applicationId);
    assert.equal("password" in detail, false);
    assert.equal("passwordHash" in detail, false);
    assert.equal("token" in detail, false);
    assert.equal(
      await (await api.applicationAudio(receipt.applicationId)).text(),
      "fixture voice",
    );
    const decisions = await Promise.allSettled([
      api.decideRegistration(
        detail.applicationId,
        "approve",
        "",
        detail.version,
        "approve-one",
      ),
      api.decideRegistration(
        detail.applicationId,
        "reject",
        "另一管理员的决定",
        detail.version,
        "reject-two",
      ),
    ]);
    assert.equal(decisions.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      (await api.application(detail.applicationId, receipt.statusToken))
        .reservedUserId,
      receipt.reservedUserId,
    );
    await api.logout();
    const logged = await api.login(
      input.email.toLowerCase(),
      input.password,
      "email",
    );
    assert.equal(logged.userId, receipt.reservedUserId);
    assert.equal(logged.verified, false);
    assert.equal(logged.emailVerified, false);
    assert.deepEqual(logged.permissions, []);
    await api.logout();
    assert.equal(
      (await api.login(receipt.reservedUserId, input.password, "user_id")).id,
      logged.id,
    );
    const proposal = await api.parseProfile("浙江，位次23500");
    assert.equal(proposal.proposedChanges.rank, 23500);
    assert.equal((await api.bootstrap()).profile, null);
    const suggestions = await api.profileSuggestions("计算");
    assert.ok(
      suggestions.majors.some((major: string) => major.includes("计算机")),
    );
    const partial = await api.profile({
      province: "",
      year: 2026,
      score: null,
      rank: null,
      subjects: [],
      cities: [],
      interests: [],
      budget: null,
      acceptAdjustment: false,
      consent: true,
      version: 0,
    });
    assert.equal(partial.version, 1);
    await assert.rejects(
      api.profile({ ...partial, version: 0 }),
      (e: any) => e.status === 409,
    );
    const question = {
      question: "比较校园生活",
      intent: "campus_life",
      riskPreference: 50,
      profileVersionId: partial.profileVersionId,
    };
    const life = await api.createRun(question, "life-one");
    assert.equal(life.status, "queued");
    assert.equal((await api.createRun(question, "life-one")).runId, life.runId);
    await assert.rejects(
      api.createRun({ ...question, question: "changed" }, "life-one"),
      (e: any) => e.status === 409,
    );
    now += 2000;
    const completedLife = await api.getRun(life.runId);
    assert.equal(completedLife.validation.status, "passed");
    assert.equal(completedLife.status, "succeeded");
    const risk = await api.createRun(
      { ...question, question: "风险分析", intent: "risk" },
      "risk-one",
    );
    assert.equal(risk.status, "waiting_input");
    assert.ok(risk.questions.some((q: any) => q.field === "rank"));
    const answered = await api.answerRun(
      risk.runId,
      {
        province_code: "浙江",
        score: "628",
        subjects: "物理,化学,生物",
        rank: "23500",
        rank_cohort: "浙江普通类省内位次",
      },
      risk.version,
      "answer-one",
    );
    assert.notEqual(
      answered.profileVersionId,
      answered.originalProfileVersionId,
    );
    now += 2000;
    const completed = await api.getRun(risk.runId);
    assert.equal(completed.validation.status, "passed");
    assert.ok(completed.items.length > 0);
    assert.equal(
      new Set(completed.items.map((i: any) => i.recommendationItemId)).size,
      completed.items.length,
    );
    assert.ok(
      completed.items.filter((i: any) => i.schoolId === "hdu").length >= 2,
    );
    assert.ok(
      completed.items.every((i: any) => i.eligibility.status !== "fail"),
    );
    const item = completed.items[0];
    await api.recommendationFeedback(
      risk.runId,
      item.recommendationItemId,
      "preference",
      "更在意预算与地域",
      "feedback-one",
    );
    assert.equal((await api.memories())[0].confirmed, false);
    assert.equal((await api.sharing()).enabled, false);
    await api.setSharing(true);
    await api.setSharing(false);
    assert.equal((await api.sharing()).enabled, false);
    const next = await api.createRun(
      { ...question, profileVersionId: answered.profileVersionId },
      "cancel-one",
    );
    const controller = new AbortController();
    controller.abort();
    for await (const _ of api.runEvents(next.runId, 0, controller.signal)) {
    }
    assert.notEqual((await api.getRun(next.runId)).status, "cancelled");
    assert.equal(
      (await api.cancelRun(next.runId, next.version, "explicit-cancel")).status,
      "cancelled",
    );
    const post = await api.submitPost({
      schoolId: "hdu",
      topic: "校园生活",
      title: "测试投稿标题",
      body: "这是一份明确的本地模拟稿件，不是真实校园体验。".repeat(5),
    });
    assert.equal(post.trust.identity, null);
    assert.equal(post.status, "pending");
    await api.login("reviewer@example.test", "NightVoyageDemo!");
    await assert.rejects(api.getRun(risk.runId), (e: any) => e.status === 403);
    assert.equal((await api.bootstrap()).profile, null);
    assert.ok(
      (await api.moderation()).items.some((p: any) => p.id === post.id),
    );
    await api.review(post.id, "approve", "合成样本检查通过", 1);
    await api.login(input.email, input.password, "email");
    assert.equal((await api.post(post.id)).isMine, true);
    const edited = await api.editPost(
      post.id,
      { title: "编辑后的测试稿件", body: "修改后的合成测试内容。".repeat(20) },
      2,
    );
    assert.equal(edited.status, "pending");
    await api.deletePost(post.id, 3);
    await assert.rejects(api.post(post.id), (e: any) => e.status === 404);
    await api.deleteProfile();
    assert.equal((await api.bootstrap()).profile, null);
    assert.deepEqual(await api.history(), []);
    assert.deepEqual(await api.memories(), []);
    assert.equal((await api.sharing()).enabled, false);
    await api.login("student@example.test", "NightVoyageDemo!");
    assert.equal((await api.bootstrap()).profile.rank, original.profile.rank);
  } finally {
    Date.now = realNow;
    await cleanup();
  }
});

test("驳回释放占用但不复用ID；学校认证独立看原件并检查版本", async () => {
  installStorage();
  const { api, cleanup } = await loadApi("mock");
  try {
    await api.logout();
    const input = {
      nickname: "测试拒",
      email: "reject@example.test",
      password: "reject-demo-password",
      evidenceText: "仅用于本地测试的申请材料。",
      evidenceAudio: null,
    };
    const first = await api.register(input, "reject-apply");
    await api.login("admin@example.test", "NightVoyageDemo!");
    await assert.rejects(
      api.decideRegistration(first.applicationId, "reject", "", 1, "no-reason"),
      (e: any) => e.status === 422,
    );
    await api.decideRegistration(
      first.applicationId,
      "reject",
      "请补充材料",
      1,
      "reject-with-reason",
    );
    await api.logout();
    const second = await api.register(input, "reapply");
    assert.notEqual(second.reservedUserId, first.reservedUserId);
    await api.login("student@example.test", "NightVoyageDemo!");
    const v = await api.verify(
      "hdu",
      new File(["synthetic document"], "test.pdf", { type: "application/pdf" }),
    );
    await api.login("reviewer@example.test", "NightVoyageDemo!");
    await assert.rejects(api.verificationQueue(), (e: any) => e.status === 403);
    await api.login("admin@example.test", "NightVoyageDemo!");
    assert.ok(
      (await api.verificationQueue()).items.some((x: any) => x.id === v.id),
    );
    assert.equal(
      await (await api.verificationDocument(v.id)).text(),
      "synthetic document",
    );
    await api.decideVerification(
      v.id,
      "approve",
      "已核对虚构样本",
      "测试学校范围",
      1,
    );
    await assert.rejects(
      api.decideVerification(v.id, "reject", "其他结论", "", 1),
      (e: any) => e.status === 409,
    );
    const user = await api.login("student@example.test", "NightVoyageDemo!");
    assert.equal(user.verified, true);
    assert.equal(user.studentVerificationScopes[0].schoolId, "hdu");
    assert.deepEqual(user.permissions, []);
  } finally {
    await cleanup();
  }
});
