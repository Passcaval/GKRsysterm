import { useEffect, useState } from "react";
import type { Profile } from "./types";
import {
  blankProfile,
  cleanNavigatorProfile,
  examProvinces,
  examSubjects,
} from "./navigator-domain";
import { missingForIntent } from "./workflow-domain";
import { validateProfile } from "./domain";

export default function NavigatorProfile({
  profile,
  proposal,
  busy,
  onRecommend,
}: {
  profile: Profile | null;
  proposal: Partial<Profile> | null;
  busy: boolean;
  onRecommend: (profile: Profile) => Promise<void>;
}) {
  const [value, setValue] = useState<Profile>(() => profile || blankProfile());
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    setValue(profile || blankProfile());
  }, [profile?.profileVersionId]);
  useEffect(() => {
    if (proposal) setValue((p) => ({ ...p, ...proposal }));
  }, [proposal]);
  function patch<K extends keyof Profile>(key: K, next: Profile[K]) {
    setValue((p) => ({ ...p, [key]: next }));
  }
  return (
    <form
      className="navigator-profile"
      onSubmit={(event) => {
        event.preventDefault();
        const cleaned = cleanNavigatorProfile(value);
        const missing = missingForIntent(cleaned, "admission");
        const problems = validateProfile(cleaned);
        if (missing.length)
          problems.push("请填写省份、位次和三门选科，并同意使用这些信息。");
        setErrors(problems);
        if (!problems.length) void onRecommend(cleaned);
      }}
    >
      <h3>{profile ? "你的报考坐标" : "先告诉我你的报考坐标"}</h3>
      <p className="muted">
        省份、位次和三门选科即可先看推荐。还没想好院校、地域或专业也没关系。
      </p>
      {proposal && <p role="status">已从对话识别部分信息，请核对后确认。</p>}
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>
            生源省份
            <select
              required
              value={value.province}
              onChange={(e) => patch("province", e.target.value)}
            >
              <option value="">请选择</option>
              {examProvinces.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            省内位次
            <input
              required
              type="number"
              min="1"
              max="5000000"
              value={value.rank ?? ""}
              onChange={(e) =>
                patch(
                  "rank",
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
            />
          </label>
          <label>
            报考年份
            <input
              required
              type="number"
              min="2024"
              max="2035"
              value={value.year}
              onChange={(e) => patch("year", Number(e.target.value))}
            />
          </label>
        </div>
        <fieldset className="navigator-subjects">
          <legend>三门选考科目（已选 {value.subjects.length}/3）</legend>
          <div className="subject-grid">
            {examSubjects.map((subject) => (
              <label key={subject}>
                <input
                  type="checkbox"
                  checked={value.subjects.includes(subject)}
                  disabled={
                    !value.subjects.includes(subject) &&
                    value.subjects.length >= 3
                  }
                  onChange={(e) =>
                    patch(
                      "subjects",
                      e.target.checked
                        ? [...value.subjects, subject]
                        : value.subjects.filter((s) => s !== subject),
                    )
                  }
                />
                {subject}
              </label>
            ))}
          </div>
        </fieldset>
        <details className="navigator-preferences">
          <summary>补充偏好，让推荐更贴近你（全部可选）</summary>
          <div className="form-grid">
            <label>
              想去的省份或城市
              <input
                value={value.cities.join("，")}
                placeholder="如：江苏，杭州"
                onChange={(e) =>
                  patch("cities", e.target.value.split(/[,，、]/))
                }
              />
            </label>
            <label>
              专业方向
              <input
                value={value.interests.join("，")}
                placeholder="如：计算机，法学"
                onChange={(e) =>
                  patch("interests", e.target.value.split(/[,，、]/))
                }
              />
            </label>
            <label>
              意向院校
              <input
                value={(value.preferredSchools || []).join("，")}
                placeholder="可以暂时留空"
                onChange={(e) =>
                  patch("preferredSchools", e.target.value.split(/[,，、]/))
                }
              />
            </label>
            <label>
              高考分数（可选）
              <input
                type="number"
                min="0"
                max="900"
                value={value.score ?? ""}
                onChange={(e) =>
                  patch(
                    "score",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </label>
            <label>
              每年学费预算 / 元（可选）
              <input
                type="number"
                min="0"
                max="10000000"
                value={value.budget ?? ""}
                onChange={(e) =>
                  patch(
                    "budget",
                    e.target.value === "" ? null : Number(e.target.value),
                  )
                }
              />
            </label>
            <label>
              位次口径（可选）
              <input
                value={value.rankCohort || ""}
                placeholder="请按成绩单口径填写"
                onChange={(e) => patch("rankCohort", e.target.value || null)}
              />
            </label>
          </div>
        </details>
        <p className="form-hint">
          当前规则与数据覆盖浙江 2026
          普通类。其他省份可保存画像，推荐会明确提示尚未支持。
        </p>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={value.consent}
            onChange={(e) => patch("consent", e.target.checked)}
          />
          同意使用以上信息生成推荐
        </label>
        <button type="submit" className="button gold-button">
          {busy ? "正在处理…" : profile ? "按当前信息更新推荐" : "先看推荐"}
        </button>
      </fieldset>
      {errors.length > 0 && (
        <p className="warning-text" role="alert">
          {errors.join("；")}
        </p>
      )}
    </form>
  );
}
