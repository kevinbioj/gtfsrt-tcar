const NAME_TO_ID: Record<string, string> = {
  Métro: "90",
  T1: "91",
  T2: "92",
  T3: "93",
  T4: "94",
  F1: "01",
  F2: "02",
  F3: "03",
  F4: "04",
  F5: "05",
  F6: "06",
  F7: "07",
  F8: "08",
};

export function matchRoute(routeName: string) {
  return NAME_TO_ID[routeName] ?? routeName;
}
