export interface Issue {
  id: string;
  status: "open" | "closed";
  labels: string[];
  estimate: number;
}
export interface FilterOptions { status?: Issue["status"]; label?: string }
export interface Summary {
  total: number;
  open: number;
  closed: number;
  estimateTotal: number;
  byLabel: Record<string, number>;
}
