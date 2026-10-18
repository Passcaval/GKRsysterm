import { useEffect, useState } from "react";
import { api } from "./api";
import { useApp } from "./store";
import type { AdmissionUnit, School } from "./types";
import { errorText } from "./transport";
export function AdmissionUnits({ school }: { school: School }) {
  const { data, update, notify } = useApp();
  const [units, setUnits] = useState<AdmissionUnit[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [history, setHistory] = useState<
      Record<string, Awaited<ReturnType<typeof api.unitHistory>>>
    >({});
  useEffect(() => {
    let active = true;
    api
      .admissionUnits(school.id)
      .then((page) => {
        if (active) {
          setUnits(page.items);
          setCursor(page.nextCursor);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [school.id]);
  async function add(unit: AdmissionUnit, major: { id: string; name: string }) {
    try {
      if (!data.user) throw new Error("请先登录");
      update({
        plan: await api.plan({
          ...data.plan,
          entries: [
            ...data.plan.entries,
            {
              id: crypto.randomUUID(),
              schoolId: school.id,
              major: major.name,
              majorId: major.id,
              admissionUnitId: unit.id,
              provinceCode: unit.provinceCode,
              examYear: unit.examYear,
              adjustment: data.profile?.acceptAdjustment ?? false,
            },
          ],
        }),
      });
      notify("已按招生单位和专业加入草案");
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <section className="panel">
      <h2>按招生单位核对条件</h2>
      <p className="muted">
        院校、专业组和专业的投档口径不同，不能用全校单个位次代表每个专业。
      </p>
      {loading && <p role="status">正在读取招生单位…</p>}
      {error && (
        <p className="warning-text" role="alert">
          {error}
        </p>
      )}
      {units.map((unit) => (
        <article className="unit-row" key={unit.id}>
          <h3>
            {unit.code || unit.id} · {unit.campusName || "校区待确认"}
          </h3>
          <p>
            {unit.provinceCode} / {unit.examYear} / {unit.examCategory} /{" "}
            {unit.batch} / {unit.unitType}
          </p>
          <p>
            选科：{unit.requiredSubjects.join(" + ") || "尚未返回"} · 数据版本{" "}
            {unit.dataVersion}
          </p>
          {unit.majors.map((major) => (
            <div className="form-actions" key={major.id}>
              <span>
                {major.name} · {major.id}
              </span>
              <button
                className="button"
                disabled={data.plan.entries.some(
                  (e) =>
                    e.admissionUnitId === unit.id && e.majorId === major.id,
                )}
                onClick={() => void add(unit, major)}
              >
                加入此专业
              </button>
            </div>
          ))}
          <button
            className="text-button"
            onClick={async () => {
              try {
                const result = await api.unitHistory(unit.id);
                setHistory((h) => ({ ...h, [unit.id]: result }));
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            查询同口径历史
          </button>
          {history[unit.id] && (
            <div>
              <p
                className={
                  history[unit.id].comparable ? "muted" : "warning-text"
                }
              >
                {history[unit.id].comparable
                  ? "后端已确认口径可比较"
                  : "历史不可比或尚未确认"}
                ：{history[unit.id].reason}
              </p>
              {history[unit.id].items.map((row, i) => (
                <p key={i}>
                  {row.year} · {row.unitType} · 投档最低位次{" "}
                  {row.minimumFilingRank ?? "未知"} · 专业录取位次{" "}
                  {row.majorAdmissionRank ?? "未知"}
                </p>
              ))}
            </div>
          )}
        </article>
      ))}
      {!loading && !units.length && <p>暂未取得这所学校的招生单位数据。</p>}
      {cursor && (
        <button
          className="button"
          onClick={async () => {
            try {
              const page = await api.admissionUnits(school.id, cursor);
              setUnits((rows) => [...rows, ...page.items]);
              setCursor(page.nextCursor);
            } catch (e) {
              setError(errorText(e));
            }
          }}
        >
          加载更多招生单位
        </button>
      )}
    </section>
  );
}
