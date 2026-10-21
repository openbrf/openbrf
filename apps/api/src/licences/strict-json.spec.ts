import { describe, expect, it } from "vite-plus/test";

import { parseStrictJson, StrictJsonError } from "./strict-json";

describe("parseStrictJson", () => {
  it("reads what JSON.parse reads", () => {
    const text =
      '{"a":[1,-2.5e3,"x\\"y",true,false,null,{}],"b":{"c":"\\u00e5"}}';
    expect(parseStrictJson(text)).toEqual(JSON.parse(text));
  });

  it.each([
    ['{"a":1,"a":2}', "at the top"],
    ['{"o":{"a":1,"b":2,"a":3}}', "in a nested object"],
    ['[{"a":1},{"a":1,"a":1}]', "in an array"],
    ['{"a":1,"\\u0061":2}', "spelled two ways"],
  ])("refuses a repeated key %s (%s)", (text) => {
    expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
  });

  it("keeps equal keys apart when they are in different objects", () => {
    expect(parseStrictJson('{"a":{"a":1},"b":{"a":2}}')).toEqual({
      a: { a: 1 },
      b: { a: 2 },
    });
  });

  it.each(['{"a":1} x', "{'a':1}", '{"a":01}', '{"a":1,}', "﻿{}", ""])(
    "refuses %j",
    (text) => {
      expect(() => parseStrictJson(text)).toThrow(StrictJsonError);
    },
  );

  it("refuses nesting deeper than a licence has", () => {
    expect(() => parseStrictJson(`${"[".repeat(40)}${"]".repeat(40)}`)).toThrow(
      StrictJsonError,
    );
  });
});
