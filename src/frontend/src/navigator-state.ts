import type { ChatMessage, Profile } from "./types.ts";
export interface NavigatorState {
  messages: ChatMessage[];
  conversationId?: string;
  profile: Profile | null;
  input: string;
}
export const emptyNavigator = (): NavigatorState => ({
  messages: [],
  conversationId: undefined,
  profile: null,
  input: "",
});
export function loadNavigator(
  owner: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): NavigatorState {
  try {
    const value = JSON.parse(
      storage.getItem("nv-navigator-v1:" + owner) || "null",
    );
    if (value?.schema !== 1 || !Array.isArray(value.messages))
      return emptyNavigator();
    return {
      messages: value.messages
        .filter(
          (m: ChatMessage) =>
            ["user", "assistant"].includes(m.role) &&
            typeof m.text === "string" &&
            Array.isArray(m.sourceIds),
        )
        .slice(-100),
      conversationId:
        typeof value.conversationId === "string"
          ? value.conversationId
          : undefined,
      profile:
        value.profile && typeof value.profile === "object"
          ? value.profile
          : null,
      input: typeof value.input === "string" ? value.input.slice(0, 4000) : "",
    };
  } catch {
    return emptyNavigator();
  }
}
export function saveNavigator(
  owner: string,
  state: NavigatorState,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  try {
    storage.setItem(
      "nv-navigator-v1:" + owner,
      JSON.stringify({
        schema: 1,
        ...state,
        messages: state.messages.slice(-100),
      }),
    );
  } catch {}
}
export function atlasContext(
  profile: Profile | null,
  cities?: string,
  majors?: string,
  query = "",
) {
  const split = (value: string) =>
    [
      ...new Set(
        value
          .split(/[,，、;；\s]+/)
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ].slice(0, 5);
  return {
    province: profile?.province || "浙江",
    year: profile?.year || 2026,
    rank: profile?.rank && profile.rank > 0 ? profile.rank : 8000,
    subjects: profile?.subjects || [],
    cities: cities === undefined ? profile?.cities || [] : split(cities),
    majors: majors === undefined ? profile?.interests || [] : split(majors),
    query: query.trim().slice(0, 100),
  };
}
export type AtlasContext = ReturnType<typeof atlasContext>;
