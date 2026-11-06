/** Client-scoped queries shared by several admin pages. */
import { useQuery } from "@tanstack/react-query";
import { type DocumentDto, REPORT_ACTIVE, type ReportDto, type ReportItemDto } from "@da/shared";
import { api } from "../../lib/api";

export const useClientDocuments = (clientId: string) =>
  useQuery({
    queryKey: ["documents", clientId],
    queryFn: () => api<DocumentDto[]>(`/clients/${clientId}/documents`),
    refetchInterval: (q) => (q.state.data?.some((d) => d.status === "scan_pending") ? 5000 : false),
  });

export const useClientReports = (clientId: string) =>
  useQuery({
    queryKey: ["reports", clientId],
    queryFn: async () => (await api<ReportDto[]>(`/clients/${clientId}/reports`)).sort((a, b) => b.requestedAt - a.requestedAt),
    refetchInterval: (q) => (q.state.data?.some((r) => REPORT_ACTIVE.includes(r.status)) ? 3000 : false),
  });

export const useReportItems = (reportId: string | undefined) =>
  useQuery({ queryKey: ["items", reportId], queryFn: () => api<ReportItemDto[]>(`/reports/${reportId}/items`), enabled: !!reportId });
