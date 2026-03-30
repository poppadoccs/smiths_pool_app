import type { FormField } from "@/lib/forms";

export type MockTemplate = {
  name: string;
  description: string;
  category: string;
  fields: FormField[];
};

export const MOCK_TEMPLATES: MockTemplate[] = [
  {
    name: "Pool Service Inspection",
    description: "Standard weekly pool service checklist",
    category: "Inspection",
    fields: [
      { id: "customer_name", label: "Customer Name", type: "text", required: true, placeholder: "Full name", order: 0 },
      { id: "service_date", label: "Service Date", type: "date", required: true, order: 1 },
      { id: "address", label: "Service Address", type: "text", required: true, placeholder: "Street, City, ZIP", order: 2 },
      { id: "phone", label: "Customer Phone", type: "phone", required: false, placeholder: "(555) 123-4567", order: 3 },
      { id: "pool_type", label: "Pool Type", type: "radio", required: true, options: ["Chlorine", "Saltwater", "Mineral"], section: "Pool Details", order: 4 },
      { id: "pool_size", label: "Pool Size (gallons)", type: "number", required: false, placeholder: "e.g., 15000", section: "Pool Details", order: 5 },
      { id: "ph_level", label: "pH Level", type: "number", required: true, placeholder: "e.g., 7.4", section: "Chemical Readings", order: 6 },
      { id: "chlorine_level", label: "Free Chlorine (ppm)", type: "number", required: true, placeholder: "e.g., 2.0", section: "Chemical Readings", order: 7 },
      { id: "alkalinity", label: "Total Alkalinity (ppm)", type: "number", required: false, placeholder: "e.g., 100", section: "Chemical Readings", order: 8 },
      { id: "filter_cleaned", label: "Filter Cleaned", type: "checkbox", required: false, section: "Tasks Completed", order: 9 },
      { id: "skimmer_emptied", label: "Skimmer Basket Emptied", type: "checkbox", required: false, section: "Tasks Completed", order: 10 },
      { id: "walls_brushed", label: "Walls Brushed", type: "checkbox", required: false, section: "Tasks Completed", order: 11 },
      { id: "vacuumed", label: "Pool Vacuumed", type: "checkbox", required: false, section: "Tasks Completed", order: 12 },
      { id: "condition", label: "Overall Pool Condition", type: "select", required: true, options: ["Excellent", "Good", "Fair", "Needs Attention", "Critical"], section: "Assessment", order: 13 },
      { id: "notes", label: "Service Notes", type: "textarea", required: false, placeholder: "Any issues, repairs needed, customer requests...", section: "Assessment", order: 14 },
      { id: "technician_signature", label: "Technician Signature", type: "signature", required: true, order: 15 },
    ],
  },
  {
    name: "Equipment Installation Form",
    description: "New equipment install documentation",
    category: "Installation",
    fields: [
      { id: "job_number", label: "Job Number", type: "text", required: true, placeholder: "e.g., 2024-100", order: 0 },
      { id: "customer", label: "Customer Name", type: "text", required: true, order: 1 },
      { id: "install_date", label: "Installation Date", type: "date", required: true, order: 2 },
      { id: "location", label: "Install Address", type: "text", required: true, order: 3 },
      { id: "email", label: "Customer Email", type: "email", required: false, placeholder: "for warranty registration", order: 4 },
      { id: "equipment_type", label: "Equipment Type", type: "select", required: true, options: ["Pump", "Filter", "Heater", "Chlorinator", "Automation System", "LED Lights", "Other"], section: "Equipment", order: 5 },
      { id: "brand_model", label: "Brand & Model", type: "text", required: true, placeholder: "e.g., Pentair IntelliFlo VSF", section: "Equipment", order: 6 },
      { id: "serial_number", label: "Serial Number", type: "text", required: true, section: "Equipment", order: 7 },
      { id: "warranty_registered", label: "Warranty Registered", type: "checkbox", required: false, section: "Equipment", order: 8 },
      { id: "old_equipment_removed", label: "Old Equipment Removed", type: "checkbox", required: false, section: "Work Performed", order: 9 },
      { id: "electrical_work", label: "Electrical Work Done", type: "checkbox", required: false, section: "Work Performed", order: 10 },
      { id: "plumbing_work", label: "Plumbing Modifications", type: "checkbox", required: false, section: "Work Performed", order: 11 },
      { id: "system_tested", label: "System Tested & Running", type: "checkbox", required: true, section: "Work Performed", order: 12 },
      { id: "hours_worked", label: "Total Hours", type: "number", required: true, placeholder: "e.g., 4.5", order: 13 },
      { id: "notes", label: "Installation Notes", type: "textarea", required: false, placeholder: "Issues, special configurations, customer instructions...", order: 14 },
      { id: "installer_sig", label: "Installer Signature", type: "signature", required: true, order: 15 },
      { id: "customer_sig", label: "Customer Signature", type: "signature", required: true, order: 16 },
    ],
  },
  {
    name: "Safety Compliance Checklist",
    description: "Pre-job site safety inspection",
    category: "Safety",
    fields: [
      { id: "inspector_name", label: "Inspector Name", type: "text", required: true, order: 0 },
      { id: "inspection_date", label: "Date", type: "date", required: true, order: 1 },
      { id: "job_site", label: "Job Site Address", type: "text", required: true, order: 2 },
      { id: "fence_intact", label: "Pool Fence Intact & Compliant", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Barriers", order: 3 },
      { id: "gate_self_closing", label: "Gate Self-Closing & Latching", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Barriers", order: 4 },
      { id: "drain_covers", label: "Drain Covers Compliant (VGB Act)", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Drains", order: 5 },
      { id: "gfci_working", label: "GFCI Outlets Working", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Electrical", order: 6 },
      { id: "bonding_grounding", label: "Bonding & Grounding Verified", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Electrical", order: 7 },
      { id: "chemical_storage", label: "Chemicals Stored Properly", type: "radio", required: true, options: ["Pass", "Fail", "N/A"], section: "Chemical Safety", order: 8 },
      { id: "rescue_equipment", label: "Rescue Equipment Present", type: "checkbox", required: false, section: "Emergency", order: 9 },
      { id: "cpr_sign_posted", label: "CPR Sign Posted", type: "checkbox", required: false, section: "Emergency", order: 10 },
      { id: "overall_rating", label: "Overall Safety Rating", type: "select", required: true, options: ["Compliant", "Minor Issues", "Major Issues", "Unsafe - Stop Work"], order: 11 },
      { id: "issues_found", label: "Issues Found", type: "textarea", required: false, placeholder: "Describe any safety concerns...", order: 12 },
      { id: "inspector_sig", label: "Inspector Signature", type: "signature", required: true, order: 13 },
    ],
  },
];

/** Pick a random mock template to simulate real AI extraction */
export function getRandomMockTemplate(): MockTemplate {
  const index = Math.floor(Math.random() * MOCK_TEMPLATES.length);
  return MOCK_TEMPLATES[index];
}
