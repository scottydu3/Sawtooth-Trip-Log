import { describe, expect, it } from "vitest";
import { parseBulk } from "../src/bulk";

describe("parseBulk", () => {
  it("reads one business per line in the common shapes", () => {
    const got = parseBulk([
      "Ace Hardware, 123 Main St, Boise, ID 83702",
      "Meridian Lumber - 45 E Pine Ave, Meridian",
      "Nampa Supply\t900 12th Ave S\tNampa\tID\t83651",
      "1. Kuna Feed, Kuna",
      "Smith - Jones Supply, 12 Front St, Eagle",
      "Caldwell Co-op, 7 Elm St",
      "",
    ].join("\n"));
    expect(got).toEqual([
      { name: "Ace Hardware", address: "123 Main St", city: "Boise" },
      { name: "Meridian Lumber", address: "45 E Pine Ave", city: "Meridian" },
      { name: "Nampa Supply", address: "900 12th Ave S", city: "Nampa" },
      { name: "Kuna Feed", address: "", city: "Kuna" },
      { name: "Smith - Jones Supply", address: "12 Front St", city: "Eagle" },
      { name: "Caldwell Co-op", address: "7 Elm St", city: "" },
    ]);
  });

  it("reads name-then-address blocks separated by blank lines", () => {
    const got = parseBulk("Ace Hardware\n123 Main St\nBoise, ID 83702\n\nMeridian Lumber\n45 E Pine Ave, Meridian, ID 83642, USA\n");
    expect(got).toEqual([
      { name: "Ace Hardware", address: "123 Main St", city: "Boise" },
      { name: "Meridian Lumber", address: "45 E Pine Ave", city: "Meridian" },
    ]);
  });

  it("keeps a plain list of names", () => {
    expect(parseBulk("Ace Hardware\nMeridian Lumber")).toEqual([
      { name: "Ace Hardware", address: "", city: "" },
      { name: "Meridian Lumber", address: "", city: "" },
    ]);
  });
});
