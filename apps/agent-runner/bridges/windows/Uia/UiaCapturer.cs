// Core UIA work — list_windows + capture.
//
// All public methods MUST be invoked from the STA worker thread. The
// FlaUI.Core types wrap COM interfaces with apartment requirements;
// touching them from any other thread leaks COM proxies and eventually
// deadlocks.

using System.Diagnostics;
using System.Runtime.InteropServices;
using FlaUI.Core;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Conditions;
using FlaUI.Core.Definitions;
using FlaUI.Core.Exceptions;
using FlaUI.Core.Patterns;
using FlaUI.UIA3;

namespace AgentMark.Bridge.Windows.Uia;

internal sealed class UiaCapturer : IDisposable
{
    private readonly UIA3Automation _automation;
    private bool _disposed;

    // Cache: element_id -> live AutomationElement. Populated during
    // Capture(); consumed by Execute(). Replaced on every new Capture.
    // Stays single-rooted (only one capture session at a time) for now;
    // multi-window concurrent capture is a future feature.
    private CaptureSession? _lastSession;

    public UiaCapturer()
    {
        _automation = new UIA3Automation();
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { _automation.Dispose(); } catch { /* swallow */ }
    }

    private sealed class CaptureSession
    {
        public required AutomationElement RootWindow { get; init; }
        public Dictionary<string, AutomationElement> Elements { get; } = new(StringComparer.Ordinal);
    }

    // ─────────────────────────────────────────────────────────────────
    // list_windows
    // ─────────────────────────────────────────────────────────────────

    public List<WindowSummaryDto> ListWindows()
    {
        var desktop = _automation.GetDesktop();
        var condition = _automation.ConditionFactory.ByControlType(ControlType.Window);
        var children = desktop.FindAllChildren(condition);

        var focused = TryGetFocused();
        var focusedHwnd = focused != null ? GetHwnd(focused) : IntPtr.Zero;

        var result = new List<WindowSummaryDto>(children.Length);
        foreach (var win in children)
        {
            string? title = SafeName(win);
            // Skip the chrome-less ghost windows Windows creates for
            // every IME / tray / hidden helper. They have no title and
            // no useful UI for an agent.
            if (string.IsNullOrEmpty(title)) continue;
            // Off-screen, minimised, or zero-size windows aren't useful.
            if (SafeIsOffscreen(win)) continue;

            var hwnd = GetHwnd(win);
            if (hwnd == IntPtr.Zero) continue;

            int? pid = SafeProcessId(win);
            string? procName = pid.HasValue ? SafeProcessName(pid.Value) : null;

            result.Add(new WindowSummaryDto
            {
                WindowId = EncodeHwnd(hwnd),
                WindowTitle = title!,
                ProcessName = procName,
                ProcessId = pid,
                WindowClass = SafeClassName(win),
                HasFocus = focusedHwnd != IntPtr.Zero && IsAncestorOrSelf(focused!, win),
            });
        }
        return result;
    }

    // ─────────────────────────────────────────────────────────────────
    // capture
    // ─────────────────────────────────────────────────────────────────

    public sealed class CaptureRequest
    {
        public string? ProcessName { get; init; }
        public int? ProcessId { get; init; }
        public string? WindowTitle { get; init; }
        public string? WindowId { get; init; }
        public int MaxDepth { get; init; } = 12;
        public bool IncludeHidden { get; init; }
        public int TimeoutMs { get; init; } = 5000;
        /// <summary>Hard cap on emitted elements to keep the wire payload
        /// bounded. Large Excel workbooks blow past 10k elements easily.</summary>
        public int MaxElements { get; init; } = 2000;
    }

    public DesktopCaptureDto Capture(CaptureRequest req)
    {
        var window = ResolveTarget(req)
            ?? throw new InvalidOperationException("No matching window found and no focused window available.");

        var hwnd = GetHwnd(window);
        var deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(500, req.TimeoutMs));

        // Start a fresh session so Execute() finds elements from THIS
        // capture (not stale ones from a previous window).
        var session = new CaptureSession { RootWindow = window };

        var ctx = new WalkContext
        {
            MaxDepth = Math.Max(1, req.MaxDepth),
            MaxElements = Math.Max(50, req.MaxElements),
            IncludeHidden = req.IncludeHidden,
            Deadline = deadline,
            Session = session,
        };

        var rootDto = WalkElement(window, depth: 0, ctx);
        _lastSession = session;

        var focused = TryGetFocused();
        string? focusedId = focused != null && IsAncestorOrSelf(focused, window)
            ? AutomationIdFor(focused)
            : null;

        int? pid = SafeProcessId(window);
        return new DesktopCaptureDto
        {
            ProcessName = pid.HasValue ? SafeProcessName(pid.Value) : null,
            ProcessId = pid,
            WindowTitle = SafeName(window) ?? "(untitled window)",
            WindowClass = SafeClassName(window),
            WindowId = EncodeHwnd(hwnd),
            FocusedElementId = focusedId,
            TreeDepth = ctx.MaxDepthReached,
            ElementCount = ctx.ElementCount,
            Root = rootDto,
        };
    }

    private sealed class WalkContext
    {
        public int MaxDepth;
        public int MaxElements;
        public bool IncludeHidden;
        public DateTime Deadline;
        public int ElementCount;
        public int MaxDepthReached;
        public required CaptureSession Session;
        public readonly HashSet<string> SeenIds = new(StringComparer.Ordinal);
    }

    private DesktopElementDto WalkElement(AutomationElement el, int depth, WalkContext ctx)
    {
        ctx.ElementCount++;
        if (depth > ctx.MaxDepthReached) ctx.MaxDepthReached = depth;

        var id = AutomationIdFor(el);
        // Disambiguate duplicate AutomationIds across siblings.
        if (ctx.SeenIds.Contains(id))
        {
            int n = 2;
            while (ctx.SeenIds.Contains($"{id}#{n}")) n++;
            id = $"{id}#{n}";
        }
        ctx.SeenIds.Add(id);
        // Stash a live handle so Execute() can find it later.
        ctx.Session.Elements[id] = el;

        var role = RoleMapper.ToRole(el);
        var dto = new DesktopElementDto
        {
            Id = id,
            Role = role,
            Name = SafeName(el),
            Value = ExtractValue(el),
            Placeholder = SafePlaceholder(el),
            Enabled = SafeBool(() => el.Properties.IsEnabled.ValueOrDefault),
            ReadOnly = ExtractReadOnly(el),
            Selected = ExtractSelected(el),
            Expanded = ExtractExpanded(el),
            Aria = BuildAria(el),
            Bounds = SafeBounds(el),
        };

        // Stop expanding past the cap; the parent still includes its
        // own data but children get truncated. The body builder on the
        // Node side renders the markdown gracefully when children are
        // null.
        if (depth >= ctx.MaxDepth) return dto;
        if (ctx.ElementCount >= ctx.MaxElements) return dto;
        if (DateTime.UtcNow > ctx.Deadline) return dto;

        AutomationElement[] children;
        try { children = el.FindAllChildren(); }
        catch { return dto; }

        if (children.Length == 0) return dto;

        var kids = new List<DesktopElementDto>(children.Length);
        foreach (var c in children)
        {
            if (ctx.ElementCount >= ctx.MaxElements) break;
            if (DateTime.UtcNow > ctx.Deadline) break;
            if (!ctx.IncludeHidden && SafeIsOffscreen(c)) continue;
            kids.Add(WalkElement(c, depth + 1, ctx));
        }
        if (kids.Count > 0) dto.Children = kids;
        return dto;
    }

    // ─────────────────────────────────────────────────────────────────
    // execute
    // ─────────────────────────────────────────────────────────────────

    public sealed class ExecuteRequest
    {
        public string ElementId { get; init; } = "";
        /// <summary>One of: click | type | select | check | expand | focus | scroll_to | key</summary>
        public string ActionType { get; init; } = "click";

        // Action-specific payloads. Only the ones relevant to ActionType
        // are read; the rest are ignored.
        public string? Text { get; init; }            // type
        public string? Value { get; init; }           // select
        public bool? Checked { get; init; }           // check
        public bool? Expanded { get; init; }          // expand
        public string? Key { get; init; }             // key
        public string[]? Modifiers { get; init; }     // key
        public bool ClearFirst { get; init; }         // type
        public int TimeoutMs { get; init; } = 5000;
    }

    public sealed class ExecuteResult
    {
        public bool Ok { get; init; }
        public string? Message { get; init; }
        public string? NewValue { get; init; }
    }

    public ExecuteResult Execute(ExecuteRequest req)
    {
        var session = _lastSession
            ?? throw new InvalidOperationException(
                "No capture session active. Call `capture` before `execute` so the bridge can resolve element_ids.");

        if (!session.Elements.TryGetValue(req.ElementId, out var element))
        {
            return new ExecuteResult
            {
                Ok = false,
                Message = $"Unknown element_id `{req.ElementId}` in the current capture session. Re-capture if the window has changed.",
            };
        }

        try
        {
            switch (req.ActionType)
            {
                case "click":   return DoClick(element);
                case "type":    return DoType(element, req.Text ?? "", req.ClearFirst);
                case "select":  return DoSelect(element, req.Value ?? "");
                case "check":   return DoCheck(element, req.Checked ?? true);
                case "expand":  return DoExpand(element, req.Expanded ?? true);
                case "focus":   return DoFocus(element);
                case "scroll_to": return DoScrollTo(element);
                case "key":     return DoKey(element, req.Key ?? "", req.Modifiers);
                default:
                    return new ExecuteResult
                    {
                        Ok = false,
                        Message = $"Unknown action type `{req.ActionType}`.",
                    };
            }
        }
        catch (ElementNotAvailableException ex)
        {
            // UIA throws this when the underlying element disappeared
            // between capture and execute (window closed, modal dismissed, etc.).
            return new ExecuteResult { Ok = false, Message = $"Element no longer available: {ex.Message}" };
        }
        catch (Exception ex)
        {
            return new ExecuteResult { Ok = false, Message = $"{ex.GetType().Name}: {ex.Message}" };
        }
    }

    private static ExecuteResult DoClick(AutomationElement el)
    {
        var patterns = el.Patterns;

        if (patterns.Invoke.IsSupported)
        {
            patterns.Invoke.Pattern.Invoke();
            return new ExecuteResult { Ok = true };
        }

        // Some controls (toggle buttons, menu items in some toolkits) only
        // support Toggle / SelectionItem. Try them in priority order.
        if (patterns.Toggle.IsSupported)
        {
            patterns.Toggle.Pattern.Toggle();
            return new ExecuteResult { Ok = true };
        }
        if (patterns.SelectionItem.IsSupported)
        {
            patterns.SelectionItem.Pattern.Select();
            return new ExecuteResult { Ok = true };
        }
        if (patterns.ExpandCollapse.IsSupported)
        {
            var p = patterns.ExpandCollapse.Pattern;
            if (p.ExpandCollapseState.ValueOrDefault == ExpandCollapseState.Expanded) p.Collapse();
            else p.Expand();
            return new ExecuteResult { Ok = true };
        }

        // Last resort: focus + simulated Space (works for buttons /
        // checkboxes / links that don't expose any of the above).
        try
        {
            el.Focus();
            FlaUI.Core.Input.Keyboard.Type(FlaUI.Core.WindowsAPI.VirtualKeyShort.SPACE);
            return new ExecuteResult { Ok = true, Message = "Used keyboard fallback (no InvokePattern)." };
        }
        catch
        {
            return new ExecuteResult { Ok = false, Message = "Element does not support any clickable pattern." };
        }
    }

    private static ExecuteResult DoType(AutomationElement el, string text, bool clearFirst)
    {
        var patterns = el.Patterns;

        if (patterns.Value.IsSupported && !patterns.Value.Pattern.IsReadOnly.ValueOrDefault)
        {
            // Most reliable path: SetValue replaces the entire content
            // atomically. Honour clear_first by treating non-clear as a
            // no-op (Value semantics is set-by-default).
            try { el.Focus(); } catch { /* ignore */ }
            patterns.Value.Pattern.SetValue(text);
            return new ExecuteResult { Ok = true, NewValue = patterns.Value.Pattern.Value.ValueOrDefault ?? text };
        }

        // Fallback: focus + simulated keystrokes. Used for elements that
        // only expose TextPattern (Documents) or no value pattern at all.
        try { el.Focus(); } catch { /* ignore */ }
        if (clearFirst)
        {
            FlaUI.Core.Input.Keyboard.TypeSimultaneously(
                FlaUI.Core.WindowsAPI.VirtualKeyShort.CONTROL,
                FlaUI.Core.WindowsAPI.VirtualKeyShort.KEY_A);
            FlaUI.Core.Input.Keyboard.Type(FlaUI.Core.WindowsAPI.VirtualKeyShort.DELETE);
        }
        FlaUI.Core.Input.Keyboard.Type(text);

        string? newValue = null;
        try
        {
            if (patterns.Value.IsSupported) newValue = patterns.Value.Pattern.Value.ValueOrDefault;
        }
        catch { /* ignore */ }

        return new ExecuteResult { Ok = true, NewValue = newValue, Message = "Used keyboard fallback (no writable ValuePattern)." };
    }

    private static ExecuteResult DoSelect(AutomationElement el, string value)
    {
        var patterns = el.Patterns;

        // Direct SelectionItem on the target: caller already knows
        // which child to select.
        if (patterns.SelectionItem.IsSupported)
        {
            patterns.SelectionItem.Pattern.Select();
            return new ExecuteResult { Ok = true, NewValue = SafeName(el) ?? value };
        }

        // The element is a Selection container (ComboBox, ListBox).
        // Expand it, then find the child whose name/value matches.
        if (patterns.Selection.IsSupported)
        {
            if (patterns.ExpandCollapse.IsSupported)
            {
                try { patterns.ExpandCollapse.Pattern.Expand(); } catch { /* ignore */ }
            }

            var children = el.FindAllChildren();
            var match = children.FirstOrDefault(c =>
                string.Equals(SafeName(c) ?? "", value, StringComparison.OrdinalIgnoreCase));
            if (match != null && match.Patterns.SelectionItem.IsSupported)
            {
                match.Patterns.SelectionItem.Pattern.Select();
                return new ExecuteResult { Ok = true, NewValue = SafeName(match) ?? value };
            }

            return new ExecuteResult { Ok = false, Message = $"No child option matched `{value}`." };
        }

        // ComboBox with editable Value (e.g. autocomplete): set the value.
        if (patterns.Value.IsSupported && !patterns.Value.Pattern.IsReadOnly.ValueOrDefault)
        {
            patterns.Value.Pattern.SetValue(value);
            return new ExecuteResult { Ok = true, NewValue = value };
        }

        return new ExecuteResult { Ok = false, Message = "Element does not support Selection or SelectionItem patterns." };
    }

    private static ExecuteResult DoCheck(AutomationElement el, bool wantChecked)
    {
        var patterns = el.Patterns;

        if (patterns.Toggle.IsSupported)
        {
            var p = patterns.Toggle.Pattern;
            // Keep toggling until the state matches; ToggleState.Indeterminate
            // (mixed) counts as not-on-yet for the wantChecked=true case.
            int guard = 3;
            while (guard-- > 0)
            {
                var current = p.ToggleState.ValueOrDefault;
                var isOn = current == ToggleState.On;
                if (isOn == wantChecked) break;
                p.Toggle();
            }
            var final = p.ToggleState.ValueOrDefault == ToggleState.On;
            return new ExecuteResult { Ok = final == wantChecked, NewValue = final ? "true" : "false" };
        }

        if (patterns.SelectionItem.IsSupported)
        {
            // Radio buttons surface as SelectionItem — selecting is the
            // only operation; "unchecking" isn't well-defined for a radio.
            if (wantChecked)
            {
                patterns.SelectionItem.Pattern.Select();
                return new ExecuteResult { Ok = true, NewValue = "true" };
            }
            return new ExecuteResult { Ok = false, Message = "Cannot uncheck a radio button directly." };
        }

        return new ExecuteResult { Ok = false, Message = "Element does not support Toggle or SelectionItem patterns." };
    }

    private static ExecuteResult DoExpand(AutomationElement el, bool wantExpanded)
    {
        if (!el.Patterns.ExpandCollapse.IsSupported)
        {
            return new ExecuteResult { Ok = false, Message = "Element does not support ExpandCollapse pattern." };
        }
        var p = el.Patterns.ExpandCollapse.Pattern;
        if (wantExpanded) p.Expand(); else p.Collapse();
        var final = p.ExpandCollapseState.ValueOrDefault;
        return new ExecuteResult { Ok = true, NewValue = final.ToString() };
    }

    private static ExecuteResult DoFocus(AutomationElement el)
    {
        el.Focus();
        return new ExecuteResult { Ok = true };
    }

    private static ExecuteResult DoScrollTo(AutomationElement el)
    {
        if (el.Patterns.ScrollItem.IsSupported)
        {
            el.Patterns.ScrollItem.Pattern.ScrollIntoView();
            return new ExecuteResult { Ok = true };
        }
        // SetFocus often implies scroll-into-view for most controls.
        try
        {
            el.Focus();
            return new ExecuteResult { Ok = true, Message = "Used SetFocus fallback (no ScrollItem pattern)." };
        }
        catch
        {
            return new ExecuteResult { Ok = false, Message = "Element does not support ScrollItem and SetFocus failed." };
        }
    }

    private static ExecuteResult DoKey(AutomationElement el, string key, string[]? modifiers)
    {
        if (string.IsNullOrEmpty(key))
        {
            return new ExecuteResult { Ok = false, Message = "Missing `key` argument." };
        }

        try { el.Focus(); } catch { /* ignore */ }

        var vk = ParseVirtualKey(key);
        if (vk == null)
        {
            // Not a named key — fall through to typing the literal text.
            FlaUI.Core.Input.Keyboard.Type(key);
            return new ExecuteResult { Ok = true, Message = $"Typed literal text `{key}`." };
        }

        var mods = (modifiers ?? Array.Empty<string>())
            .Select(ParseModifier)
            .Where(m => m.HasValue)
            .Select(m => m!.Value)
            .ToArray();

        if (mods.Length == 0)
        {
            FlaUI.Core.Input.Keyboard.Type(vk.Value);
        }
        else
        {
            var combo = mods.Append(vk.Value).ToArray();
            FlaUI.Core.Input.Keyboard.TypeSimultaneously(combo);
        }

        return new ExecuteResult { Ok = true };
    }

    private static FlaUI.Core.WindowsAPI.VirtualKeyShort? ParseVirtualKey(string key)
    {
        // Accept common friendly names; fall through to anything that
        // matches the enum case-insensitively.
        var lowered = key.ToLowerInvariant();
        return lowered switch
        {
            "enter" or "return" => FlaUI.Core.WindowsAPI.VirtualKeyShort.RETURN,
            "tab" => FlaUI.Core.WindowsAPI.VirtualKeyShort.TAB,
            "escape" or "esc" => FlaUI.Core.WindowsAPI.VirtualKeyShort.ESCAPE,
            "space" or "spacebar" => FlaUI.Core.WindowsAPI.VirtualKeyShort.SPACE,
            "backspace" => FlaUI.Core.WindowsAPI.VirtualKeyShort.BACK,
            "delete" or "del" => FlaUI.Core.WindowsAPI.VirtualKeyShort.DELETE,
            "home" => FlaUI.Core.WindowsAPI.VirtualKeyShort.HOME,
            "end" => FlaUI.Core.WindowsAPI.VirtualKeyShort.END,
            "pageup" or "pgup" => FlaUI.Core.WindowsAPI.VirtualKeyShort.PRIOR,
            "pagedown" or "pgdn" => FlaUI.Core.WindowsAPI.VirtualKeyShort.NEXT,
            "up" => FlaUI.Core.WindowsAPI.VirtualKeyShort.UP,
            "down" => FlaUI.Core.WindowsAPI.VirtualKeyShort.DOWN,
            "left" => FlaUI.Core.WindowsAPI.VirtualKeyShort.LEFT,
            "right" => FlaUI.Core.WindowsAPI.VirtualKeyShort.RIGHT,
            "f1" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F1,
            "f2" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F2,
            "f3" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F3,
            "f4" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F4,
            "f5" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F5,
            "f6" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F6,
            "f7" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F7,
            "f8" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F8,
            "f9" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F9,
            "f10" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F10,
            "f11" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F11,
            "f12" => FlaUI.Core.WindowsAPI.VirtualKeyShort.F12,
            _ => Enum.TryParse<FlaUI.Core.WindowsAPI.VirtualKeyShort>(key, ignoreCase: true, out var v) ? v : null,
        };
    }

    private static FlaUI.Core.WindowsAPI.VirtualKeyShort? ParseModifier(string m)
    {
        return m.ToLowerInvariant() switch
        {
            "ctrl" or "control" => FlaUI.Core.WindowsAPI.VirtualKeyShort.CONTROL,
            "alt" => FlaUI.Core.WindowsAPI.VirtualKeyShort.ALT,
            "shift" => FlaUI.Core.WindowsAPI.VirtualKeyShort.SHIFT,
            "meta" or "win" or "windows" => FlaUI.Core.WindowsAPI.VirtualKeyShort.LWIN,
            _ => null,
        };
    }

    // ─────────────────────────────────────────────────────────────────
    // Target resolution
    // ─────────────────────────────────────────────────────────────────

    private AutomationElement? ResolveTarget(CaptureRequest req)
    {
        // window_id (HWND) is the most precise match — use it first.
        if (!string.IsNullOrWhiteSpace(req.WindowId) && TryDecodeHwnd(req.WindowId, out var hwnd))
        {
            try
            {
                var elFromHwnd = _automation.FromHandle(hwnd);
                if (elFromHwnd != null) return elFromHwnd;
            }
            catch { /* fall through to other strategies */ }
        }

        // For the remaining strategies we scan top-level windows once.
        var desktop = _automation.GetDesktop();
        var allWindows = desktop.FindAllChildren(
            _automation.ConditionFactory.ByControlType(ControlType.Window));

        if (req.ProcessId is int pid)
        {
            var match = allWindows.FirstOrDefault(w => SafeProcessId(w) == pid && !string.IsNullOrEmpty(SafeName(w)));
            if (match != null) return match;
        }

        if (!string.IsNullOrWhiteSpace(req.ProcessName))
        {
            var target = req.ProcessName.ToLowerInvariant().TrimEnd('.', 'e', 'x', 'e');
            var match = allWindows.FirstOrDefault(w =>
            {
                var p = SafeProcessId(w);
                if (!p.HasValue) return false;
                var name = SafeProcessName(p.Value);
                if (string.IsNullOrEmpty(name)) return false;
                return name!.ToLowerInvariant().TrimEnd('.', 'e', 'x', 'e').Contains(target);
            });
            if (match != null) return match;
        }

        if (!string.IsNullOrWhiteSpace(req.WindowTitle))
        {
            var target = req.WindowTitle.ToLowerInvariant();
            var match = allWindows.FirstOrDefault(w =>
                (SafeName(w)?.ToLowerInvariant() ?? "").Contains(target));
            if (match != null) return match;
        }

        // Default: focused window.
        var focused = TryGetFocused();
        if (focused != null)
        {
            var root = FindTopLevelAncestor(focused);
            if (root != null) return root;
        }
        return null;
    }

    private static AutomationElement? FindTopLevelAncestor(AutomationElement el)
    {
        var current = el;
        while (current != null)
        {
            try
            {
                if (current.Properties.ControlType.ValueOrDefault == ControlType.Window) return current;
                current = current.Parent;
            }
            catch { return null; }
        }
        return null;
    }

    private AutomationElement? TryGetFocused()
    {
        try { return _automation.FocusedElement(); } catch { return null; }
    }

    // ─────────────────────────────────────────────────────────────────
    // Property extraction helpers — all defensive, all swallow.
    // ─────────────────────────────────────────────────────────────────

    private static string AutomationIdFor(AutomationElement el)
    {
        try
        {
            var id = el.Properties.AutomationId.ValueOrDefault;
            if (!string.IsNullOrEmpty(id)) return id!;
        }
        catch { /* fall through */ }
        // Fall back to a stable hash of name+role+pid. Avoids unstable
        // RuntimeId which can churn across captures.
        var name = SafeName(el) ?? "";
        var role = SafeControlType(el);
        var pid = SafeProcessId(el) ?? 0;
        return $"el_{(uint)HashCode.Combine(name, role, pid):x8}";
    }

    private static string SafeControlType(AutomationElement el)
    {
        try { return el.Properties.ControlType.ValueOrDefault.ToString(); }
        catch { return "Unknown"; }
    }

    private static string? SafeName(AutomationElement el)
    {
        try
        {
            var n = el.Properties.Name.ValueOrDefault;
            return string.IsNullOrEmpty(n) ? null : n;
        }
        catch { return null; }
    }

    private static string? SafeClassName(AutomationElement el)
    {
        try
        {
            var c = el.Properties.ClassName.ValueOrDefault;
            return string.IsNullOrEmpty(c) ? null : c;
        }
        catch { return null; }
    }

    private static int? SafeProcessId(AutomationElement el)
    {
        try { return el.Properties.ProcessId.ValueOrDefault; }
        catch { return null; }
    }

    private static string? SafeProcessName(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.ProcessName;
        }
        catch { return null; }
    }

    private static string? SafePlaceholder(AutomationElement el)
    {
        try
        {
            // Edit + Document expose HelpText; UIA HelpText is the
            // closest analog to HTML placeholder.
            var h = el.Properties.HelpText.ValueOrDefault;
            return string.IsNullOrEmpty(h) ? null : h;
        }
        catch { return null; }
    }

    private static bool? SafeBool(Func<bool> f)
    {
        try { return f(); } catch { return null; }
    }

    private static bool SafeIsOffscreen(AutomationElement el)
    {
        try { return el.Properties.IsOffscreen.ValueOrDefault; }
        catch { return false; }
    }

    private static BoundsDto? SafeBounds(AutomationElement el)
    {
        try
        {
            var r = el.BoundingRectangle;
            if (r.IsEmpty) return null;
            return new BoundsDto
            {
                X = r.X,
                Y = r.Y,
                Width = r.Width,
                Height = r.Height,
            };
        }
        catch { return null; }
    }

    /// <summary>Extract a "current value" string from whichever pattern
    /// the element supports — ValuePattern (most controls),
    /// RangeValuePattern (sliders/progress), TextPattern.DocumentRange
    /// (Edit / Document).</summary>
    private static string? ExtractValue(AutomationElement el)
    {
        try
        {
            var patterns = el.Patterns;

            if (patterns.Value.IsSupported)
            {
                var v = patterns.Value.Pattern.Value.ValueOrDefault;
                if (!string.IsNullOrEmpty(v)) return v;
            }

            if (patterns.RangeValue.IsSupported)
            {
                var v = patterns.RangeValue.Pattern.Value.ValueOrDefault;
                return v.ToString("0.###");
            }

            if (patterns.Text.IsSupported)
            {
                // Restrict to first 2 KB; some Documents are huge and
                // we don't want to ship a novel over the wire by
                // accident.
                try
                {
                    var range = patterns.Text.Pattern.DocumentRange;
                    var text = range.GetText(2048);
                    return string.IsNullOrEmpty(text) ? null : text;
                }
                catch { /* fall through */ }
            }

            // Toggle / SelectionItem are surfaced via Selected/Aria instead.
        }
        catch { /* swallow */ }
        return null;
    }

    private static bool? ExtractReadOnly(AutomationElement el)
    {
        try
        {
            var p = el.Patterns;
            if (p.Value.IsSupported)
            {
                return p.Value.Pattern.IsReadOnly.ValueOrDefault;
            }
            if (p.RangeValue.IsSupported)
            {
                return p.RangeValue.Pattern.IsReadOnly.ValueOrDefault;
            }
        }
        catch { /* swallow */ }
        return null;
    }

    private static bool? ExtractSelected(AutomationElement el)
    {
        try
        {
            var p = el.Patterns;
            if (p.SelectionItem.IsSupported)
            {
                return p.SelectionItem.Pattern.IsSelected.ValueOrDefault;
            }
        }
        catch { /* swallow */ }
        return null;
    }

    private static bool? ExtractExpanded(AutomationElement el)
    {
        try
        {
            var p = el.Patterns;
            if (p.ExpandCollapse.IsSupported)
            {
                return p.ExpandCollapse.Pattern.ExpandCollapseState.ValueOrDefault
                    == ExpandCollapseState.Expanded;
            }
        }
        catch { /* swallow */ }
        return null;
    }

    private static AriaStateDto? BuildAria(AutomationElement el)
    {
        try
        {
            var p = el.Patterns;

            if (p.Toggle.IsSupported)
            {
                var st = p.Toggle.Pattern.ToggleState.ValueOrDefault;
                return new AriaStateDto
                {
                    Pressed = st == ToggleState.On,
                    Checked = st switch
                    {
                        ToggleState.On => (object)true,
                        ToggleState.Off => false,
                        ToggleState.Indeterminate => "mixed",
                        _ => false,
                    },
                };
            }
        }
        catch { /* swallow */ }
        return null;
    }

    private static bool IsAncestorOrSelf(AutomationElement node, AutomationElement maybeAncestor)
    {
        try
        {
            var ancHwnd = GetHwnd(maybeAncestor);
            var current = node;
            while (current != null)
            {
                if (GetHwnd(current) == ancHwnd && ancHwnd != IntPtr.Zero) return true;
                if (current.Equals(maybeAncestor)) return true;
                current = current.Parent;
            }
        }
        catch { /* swallow */ }
        return false;
    }

    private static IntPtr GetHwnd(AutomationElement el)
    {
        try { return el.Properties.NativeWindowHandle.ValueOrDefault; }
        catch { return IntPtr.Zero; }
    }

    private static string EncodeHwnd(IntPtr hwnd) =>
        $"hwnd:0x{hwnd.ToInt64():X8}";

    private static bool TryDecodeHwnd(string encoded, out IntPtr hwnd)
    {
        hwnd = IntPtr.Zero;
        if (string.IsNullOrEmpty(encoded)) return false;
        var s = encoded.StartsWith("hwnd:", StringComparison.OrdinalIgnoreCase)
            ? encoded[5..] : encoded;
        if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s[2..];
        if (long.TryParse(s, System.Globalization.NumberStyles.HexNumber, null, out var v))
        {
            hwnd = new IntPtr(v);
            return true;
        }
        return false;
    }
}

