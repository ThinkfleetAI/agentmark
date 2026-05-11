// JSON-RPC 2.0 wire types. Identical envelope to the Windows bridge.

import Foundation

// MARK: - Request

/// JSON-RPC 2.0 request. We accept any JSON value for `id` (number,
/// string, or null); store it raw and echo it back unmodified on the
/// response so different clients (number ids, uuid string ids) all work.
struct JsonRpcRequest {
    let id: JsonRpcId
    let method: String
    let params: JsonValue?

    static func decode(jsonString: String) throws -> JsonRpcRequest {
        guard let data = jsonString.data(using: .utf8) else {
            throw RpcError(code: RpcErrorCode.parseError, message: "Input is not valid UTF-8")
        }
        guard let any = try? JSONSerialization.jsonObject(with: data, options: [.allowFragments]) else {
            throw RpcError(code: RpcErrorCode.parseError, message: "Input is not valid JSON")
        }
        guard let obj = any as? [String: Any] else {
            throw RpcError(code: RpcErrorCode.invalidRequest, message: "JSON-RPC request must be an object")
        }
        guard let method = obj["method"] as? String, !method.isEmpty else {
            throw RpcError(code: RpcErrorCode.invalidRequest, message: "Missing `method`")
        }
        let id = JsonRpcId.fromAny(obj["id"])
        let params: JsonValue? = obj["params"].flatMap(JsonValue.fromAny)
        return JsonRpcRequest(id: id, method: method, params: params)
    }
}

// MARK: - Response

struct JsonRpcResponse {
    let id: JsonRpcId
    let kind: Kind

    enum Kind {
        case success(result: Any)
        case error(code: Int, message: String)
    }

    static func success(id: JsonRpcId, result: Any) -> JsonRpcResponse {
        JsonRpcResponse(id: id, kind: .success(result: result))
    }

    static func error(id: JsonRpcId, code: Int, message: String) -> JsonRpcResponse {
        JsonRpcResponse(id: id, kind: .error(code: code, message: message))
    }

    func encode() throws -> String {
        var dict: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id.toAny(),
        ]
        switch kind {
        case .success(let result):
            dict["result"] = result
        case .error(let code, let message):
            dict["error"] = [
                "code": code,
                "message": message,
            ]
        }
        let data = try JSONSerialization.data(
            withJSONObject: dict,
            options: [.withoutEscapingSlashes]
        )
        guard let s = String(data: data, encoding: .utf8) else {
            throw RpcError(code: RpcErrorCode.internalError, message: "Failed to serialise response as UTF-8")
        }
        return s
    }
}

// MARK: - JsonRpcId

/// JSON-RPC ids can be number, string, or null. Hold the original
/// representation so we round-trip exactly.
enum JsonRpcId {
    case number(Double)
    case string(String)
    case null

    static func fromAny(_ value: Any?) -> JsonRpcId {
        if value == nil { return .null }
        if let v = value as? NSNumber {
            // NSNumber covers Int/Double/Bool from JSONSerialization
            if CFGetTypeID(v) == CFBooleanGetTypeID() { return .null }
            return .number(v.doubleValue)
        }
        if let s = value as? String { return .string(s) }
        return .null
    }

    func toAny() -> Any {
        switch self {
        case .number(let d):
            // Emit ints as ints when possible so clients see id=1, not id=1.0.
            if d.truncatingRemainder(dividingBy: 1) == 0
                && d >= Double(Int.min) && d <= Double(Int.max) {
                return Int(d)
            }
            return d
        case .string(let s):
            return s
        case .null:
            return NSNull()
        }
    }
}

// MARK: - JsonValue

/// Lightweight wrapper for arbitrary JSON values plucked from the
/// request's `params` field. Most handlers project the few fields they
/// need out via the `dict`/`string(at:)` etc. helpers.
enum JsonValue {
    case object([String: Any])
    case array([Any])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null

    static func fromAny(_ value: Any) -> JsonValue {
        if let d = value as? [String: Any] { return .object(d) }
        if let a = value as? [Any] { return .array(a) }
        if let s = value as? String { return .string(s) }
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return .bool(n.boolValue) }
            return .number(n.doubleValue)
        }
        return .null
    }

    var dict: [String: Any]? {
        if case .object(let d) = self { return d }
        return nil
    }

    func string(_ key: String) -> String? {
        return (dict?[key] as? String)
    }

    func int(_ key: String) -> Int? {
        if let n = dict?[key] as? NSNumber { return n.intValue }
        return nil
    }

    func bool(_ key: String) -> Bool? {
        if let n = dict?[key] as? NSNumber,
           CFGetTypeID(n) == CFBooleanGetTypeID() {
            return n.boolValue
        }
        return nil
    }
}

// MARK: - Errors

enum RpcErrorCode: Int {
    case parseError      = -32700
    case invalidRequest  = -32600
    case methodNotFound  = -32601
    case invalidParams   = -32602
    case internalError   = -32603

    // Bridge-specific (above -32000)
    case windowNotFound   = -32010
    case elementNotFound  = -32011
    case unsupportedPattern = -32012
    case actionFailed     = -32013
    case accessibilityNotGranted = -32020
}

struct RpcError: Error {
    let code: Int
    let message: String
    var requestId: JsonRpcId = .null

    init(code: RpcErrorCode, message: String, requestId: JsonRpcId = .null) {
        self.code = code.rawValue
        self.message = message
        self.requestId = requestId
    }
}
