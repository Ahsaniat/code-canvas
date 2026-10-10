import { describe, expect, it } from 'vitest';
import {
    parseCsImports,
    parseGoImports,
    parseJavaImports,
    parseRustImports,
} from '../../../extension/src/imports';
import { extractDocSummary, extractExportedSymbols } from '../../../extension/src/describe';

describe('parseGoImports', () => {
    it('parses single and block imports with aliases', () => {
        const src = `package main

import "fmt"
import (
    "net/http"
    m "github.com/me/pkg/mod"
    _ "embed"
)`;
        const specs = parseGoImports(src);
        expect(specs.map(s => s.spec)).toEqual(['fmt', 'net/http', 'github.com/me/pkg/mod', 'embed']);
        expect(specs.find(s => s.spec === 'github.com/me/pkg/mod')!.bindings[0]).toMatchObject({ name: 'm', kind: 'module' });
        expect(specs.find(s => s.spec === 'embed')!.bindings[0]).toMatchObject({ name: '_' });
    });
});

describe('parseRustImports', () => {
    it('marks mod declarations and use paths', () => {
        const src = `mod util;
pub mod api;
use crate::model::Thing;
use self::helpers::{a, b};
`;
        expect(parseRustImports(src).map(s => s.spec)).toEqual([
            'mod:util',
            'mod:api',
            'use:crate::model::Thing',
            'use:self::helpers',
        ]);
    });
});

describe('parseJavaImports', () => {
    it('parses type, static and wildcard imports', () => {
        const src = `package a.b;
import java.util.List;
import static a.b.C.method;
import a.b.*;
`;
        const specs = parseJavaImports(src);
        expect(specs.map(s => s.spec)).toEqual(['java.util.List', 'a.b.C.method', 'a.b.*']);
        expect(specs[2].bindings[0].name).toBe('*');
    });
});

describe('parseCsImports', () => {
    it('parses using directives and skips aliases and statements', () => {
        const src = `global using System;
using System.Collections.Generic;
using Foo = Bar.Baz;
using (var x = Open()) { }
using static System.Math;
`;
        expect(parseCsImports(src).map(s => s.spec)).toEqual([
            'System',
            'System.Collections.Generic',
            'System.Math',
        ]);
    });
});

describe('new-language doc extraction', () => {
    it('reads a Go package comment', () => {
        const src = `// Package util does useful things for the app.
package util

func DoWork() {}
`;
        expect(extractDocSummary(src, 'go')).toBe('Package util does useful things for the app.');
    });

    it('reads Rust inner docs and skips crate attributes', () => {
        const src = `#![allow(dead_code)]
//! Math helpers for the crate.

pub struct Vec2;
`;
        expect(extractDocSummary(src, 'rs')).toBe('Math helpers for the crate.');
    });

    it('reads the Javadoc above the first type', () => {
        const src = `package a.b;

/** A widget that renders things. */
public final class Widget {
    public void render() {}
}
class Hidden {}
`;
        expect(extractDocSummary(src, 'java')).toBe('A widget that renders things.');
    });

    it('reads a C# summary block', () => {
        const src = `using System;

namespace App.Core;

/// <summary>Does the core work.</summary>
public sealed class Worker { }
`;
        expect(extractDocSummary(src, 'cs')).toBe('Does the core work.');
    });
});

describe('new-language symbol extraction', () => {
    it('exports only upper-case Go identifiers', () => {
        const src = `package util

func DoWork() {}
func helper() {}
type Thing struct{}
const MaxSize = 3
var internal = 1
`;
        expect(extractExportedSymbols(src, 'go')).toEqual(['DoWork', 'Thing', 'MaxSize']);
    });

    it('exports pub Rust items only', () => {
        const src = `pub struct Vec2;
pub fn add(a: u32) -> u32 { a }
fn private() {}
pub const MAX: u32 = 1;
`;
        expect(extractExportedSymbols(src, 'rs')).toEqual(['Vec2', 'add', 'MAX']);
    });

    it('exports public Java types only', () => {
        const src = `public final class Widget {
    public void render() {}
}
class Hidden {}
public interface Service {}
`;
        expect(extractExportedSymbols(src, 'java')).toEqual(['Widget', 'Service']);
    });

    it('exports public C# types only', () => {
        const src = `public sealed class Worker { }
internal class Hidden { }
public enum Mode { A, B }
`;
        expect(extractExportedSymbols(src, 'cs')).toEqual(['Worker', 'Mode']);
    });
});
