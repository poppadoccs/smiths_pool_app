import { describe, it, expect } from "vitest";
import { buildSubmissionEmail } from "@/lib/email";
import { DEFAULT_TEMPLATE } from "@/lib/forms";

describe("buildSubmissionEmail", () => {
  const baseProps = {
    jobTitle: "Smith Residence",
    jobNumber: "2024-042",
    submittedBy: "Mike",
    formData: {
      customer_name: "John Smith",
      address: "123 Main St",
      pool_type: "Inground",
      pool_shape: "Rectangular",
      length: "32",
      width: "16",
      depth_shallow: "3.5",
      depth_deep: "8",
      has_pump: true,
      has_filter: true,
      has_heater: false,
      has_lights: false,
      notes: "Blue tile preferred",
    },
    template: DEFAULT_TEMPLATE,
    photos: [
      {
        url: "https://blob.example.com/photo1.jpg",
        filename: "site-front.jpg",
        size: 500000,
        uploadedAt: "2024-01-15T10:00:00Z",
      },
    ],
  };

  it("includes job title and number", () => {
    const html = buildSubmissionEmail(baseProps);
    expect(html).toContain("Smith Residence");
    expect(html).toContain("#2024-042");
  });

  it("includes submitter name", () => {
    const html = buildSubmissionEmail(baseProps);
    expect(html).toContain("Mike");
  });

  it("renders form field labels and values", () => {
    const html = buildSubmissionEmail(baseProps);
    expect(html).toContain("Customer Name");
    expect(html).toContain("John Smith");
    expect(html).toContain("Pool Type");
    expect(html).toContain("Inground");
    expect(html).toContain("Length (ft)");
    expect(html).toContain("32");
  });

  it("renders checkboxes as Yes/No", () => {
    const html = buildSubmissionEmail(baseProps);
    expect(html).toContain("Pump Installed");
    // true → Yes
    expect(html.indexOf("Yes")).toBeGreaterThan(-1);
    // false → No
    expect(html.indexOf("No")).toBeGreaterThan(-1);
  });

  it("renders photo thumbnails with links", () => {
    const html = buildSubmissionEmail(baseProps);
    expect(html).toContain("https://blob.example.com/photo1.jpg");
    expect(html).toContain("Photos (1)");
    expect(html).toContain("Click any photo to view full size");
  });

  it("omits photo section when no photos", () => {
    const html = buildSubmissionEmail({ ...baseProps, photos: [] });
    expect(html).not.toContain("Photos (");
    expect(html).not.toContain("Click any photo");
  });

  it("escapes HTML in user content", () => {
    const html = buildSubmissionEmail({
      ...baseProps,
      formData: { ...baseProps.formData, notes: '<script>alert("xss")</script>' },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("shows dash for empty optional fields", () => {
    const html = buildSubmissionEmail({
      ...baseProps,
      formData: { ...baseProps.formData, notes: "" },
    });
    // The dash character is inside a span
    expect(html).toContain("—");
  });
});
