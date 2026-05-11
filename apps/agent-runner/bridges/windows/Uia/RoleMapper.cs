// Maps UIA ControlType (and a few special cases) to the normalised
// DesktopRole vocabulary the AgentMark v0.4 spec defines. Producers on
// other platforms (macOS AXAPI, Linux AT-SPI, vision fallback) all emit
// the same vocabulary so the Node-side body-builder can render them
// uniformly.
//
// Unrecognised types fall through to "other". The walker drops "other"
// non-leaf nodes from the rendered body but their interactive children
// are still surfaced — keeps the markdown clean without losing actions.

using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;

namespace AgentMark.Bridge.Windows.Uia;

internal static class RoleMapper
{
    public static string ToRole(AutomationElement el)
    {
        try
        {
            // ControlType resolves through cached or live properties; in
            // a tight tree walk we sometimes see UIA mid-update so guard
            // every property read.
            var ct = el.Properties.ControlType.ValueOrDefault;

            return ct switch
            {
                ControlType.Window => "window",
                ControlType.Pane => "pane",
                ControlType.Group => "group",
                ControlType.ToolBar => "toolbar",
                ControlType.MenuBar => "menu",
                ControlType.Menu => "menu",
                ControlType.MenuItem => "menu_item",
                ControlType.Tab => "tab_list",
                ControlType.TabItem => "tab",
                ControlType.Tree => "tree",
                ControlType.TreeItem => "tree_item",
                ControlType.List => "list",
                ControlType.ListItem => "list_item",
                ControlType.Table => "table",
                ControlType.DataGrid => "table",
                ControlType.DataItem => "row",
                ControlType.Header => "row",
                ControlType.HeaderItem => "column_header",
                ControlType.Button => "button",
                ControlType.SplitButton => "split_button",
                ControlType.Edit => IsPasswordEdit(el) ? "password_input" : "text_input",
                ControlType.Document => "text_area",
                ControlType.CheckBox => "check_box",
                ControlType.RadioButton => "radio_button",
                ControlType.ComboBox => "combo_box",
                ControlType.Slider => "slider",
                ControlType.ProgressBar => "progress_bar",
                ControlType.Hyperlink => "link",
                ControlType.Text => "static_text",
                ControlType.Image => "image",
                ControlType.Separator => "separator",
                ControlType.StatusBar => "status_bar",
                ControlType.ScrollBar => "scroll_bar",
                ControlType.ToolTip => "tooltip",
                ControlType.Custom => InferCustom(el),
                _ => "other",
            };
        }
        catch
        {
            return "other";
        }
    }

    /// <summary>
    /// UIA exposes IsPassword via the password-controls property. FlaUI
    /// surfaces it on Edit elements; some controls (web embeddings,
    /// custom controls) don't set it even when they should — best effort.
    /// </summary>
    private static bool IsPasswordEdit(AutomationElement el)
    {
        try { return el.Properties.IsPassword.ValueOrDefault; }
        catch { return false; }
    }

    /// <summary>
    /// Custom controls are common in WPF / WinForms / Electron-hosted
    /// pieces. Use the LocalizedControlType string + simple heuristics
    /// to guess a useful role before falling through to "other".
    /// </summary>
    private static string InferCustom(AutomationElement el)
    {
        try
        {
            var localized = el.Properties.LocalizedControlType.ValueOrDefault?.ToLowerInvariant();
            if (string.IsNullOrEmpty(localized)) return "other";

            return localized switch
            {
                _ when localized.Contains("button") => "button",
                _ when localized.Contains("textbox") || localized.Contains("text box") || localized.Contains("edit") => "text_input",
                _ when localized.Contains("checkbox") || localized.Contains("check box") => "check_box",
                _ when localized.Contains("radio") => "radio_button",
                _ when localized.Contains("combo") || localized.Contains("dropdown") => "combo_box",
                _ when localized.Contains("link") => "link",
                _ when localized.Contains("label") => "label",
                _ when localized.Contains("group") => "group",
                _ when localized.Contains("panel") => "pane",
                _ when localized.Contains("toolbar") || localized.Contains("tool bar") => "toolbar",
                _ when localized.Contains("menu") => "menu",
                _ when localized.Contains("tab") => "tab",
                _ when localized.Contains("list item") || localized.Contains("listitem") => "list_item",
                _ when localized.Contains("list") => "list",
                _ when localized.Contains("tree") => "tree",
                _ => "other",
            };
        }
        catch { return "other"; }
    }
}
