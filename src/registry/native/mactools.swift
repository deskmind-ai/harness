// macOS built-ins the tool capabilities need that have no command-line tool (src/registry/tools.ts). Compiled once with
// swiftc into a cache folder (src/registry/mac.ts); everything runs on this Mac.
//   mactools ocr <image>   ->  {"lines": [...]}   text lines read by Vision (zh-Hans, en), top to bottom
//   mactools pdf <file>    ->  {"pages": n, "text": "..."}   what PDFKit reads from a PDF (to check one we wrote)
// The OCR is the same Vision request hands uses for screens (hands tools/native/ocr.swift), without its per-segment
// splitting, which only matters for clicking.
import Foundation
import Vision
import AppKit
import PDFKit

func out(_ obj: [String: Any]) {
    print(String(data: try! JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)
}
func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(1)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: mactools ocr|pdf <path>") }
let path = args[2]

switch args[1] {
case "ocr":
    guard let img = NSImage(contentsOfFile: path), let raw = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        fail("cannot read image \(path)")
    }
    // Onto white first: dark text on a transparent background (a rendered page, some screenshots) reads as nothing.
    let W = raw.width, H = raw.height
    guard let ctx = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { fail("cannot draw \(path)") }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))
    ctx.draw(raw, in: CGRect(x: 0, y: 0, width: W, height: H))
    guard let cg = ctx.makeImage() else { fail("cannot draw \(path)") }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = .accurate
    req.recognitionLanguages = ["zh-Hans", "en-US"]
    req.usesLanguageCorrection = true
    do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch { fail("vision: \(error)") }
    // Vision's boxes have a bottom-left origin: higher maxY is nearer the top. Lines are read top to bottom, then left
    // to right among boxes on the same row.
    let obs = (req.results ?? []).compactMap { o -> (CGRect, String)? in
        guard let t = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespaces), !t.isEmpty else { return nil }
        return (o.boundingBox, t)
    }
    let sorted = obs.sorted { a, b in
        abs(a.0.midY - b.0.midY) < min(a.0.height, b.0.height) / 2 ? a.0.minX < b.0.minX : a.0.midY > b.0.midY
    }
    out(["lines": sorted.map { $0.1 }])
case "pdf":
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("not a PDF: \(path)") }
    out(["pages": doc.pageCount, "text": doc.string ?? ""])
default:
    fail("unknown command \(args[1])")
}
