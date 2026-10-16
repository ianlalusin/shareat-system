

"use client";

import { toast } from "@/hooks/use-toast";
import type { WorkBook, WorkSheet } from "xlsx";

type ExportParams = {
  filename?: string;
} & ({
  rows: any[];
  sheetName?: string;
  sheets?: never;
} | {
  rows?: never;
  sheetName?: never;
  sheets: { data: any[]; name: string }[];
});


/**
 * A client-side helper to export data to an XLSX file.
 * This function dynamically imports the 'xlsx' library to avoid including it
 * in the server-side bundle, which can cause build issues with Next.js.
 *
 * It supports exporting either a single sheet or multiple sheets.
 *
 * @param {ExportParams} params - The parameters for the export.
 */
export async function exportToXlsx({
  rows,
  sheetName = "Sheet 1",
  sheets,
  filename = "export.xlsx",
}: ExportParams) {
  
  const hasSingleSheetData = rows && rows.length > 0;
  const hasMultiSheetData = sheets && sheets.every(s => s.data.length > 0);

  if (!hasSingleSheetData && !hasMultiSheetData) {
    toast({
      variant: "destructive",
      title: "Export Failed",
      description: "There is no data to export.",
    });
    return;
  }

  try {
    const XLSX = await import("xlsx");
    const workbook: WorkBook = XLSX.utils.book_new();

    if (hasSingleSheetData) {
        const worksheet: WorkSheet = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
    } else if (hasMultiSheetData) {
        sheets.forEach(sheet => {
            const worksheet = XLSX.utils.json_to_sheet(sheet.data);
            XLSX.utils.book_append_sheet(workbook, worksheet, sheet.name);
        });
    }

    XLSX.writeFile(workbook, filename);
  } catch (error) {
    console.error("[exportToXlsx] Failed to export:", error);
    toast({
      variant: "destructive",
      title: "Export Failed",
      description: "An unexpected error occurred while generating the file.",
    });
  }
}
