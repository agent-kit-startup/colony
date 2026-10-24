// Colony bar widget for omarchy-shell (installed by Colony: More → Omarchy integration…).
// Polls `colony status --bar`, which aggregates the status files the running Colony
// windows keep in $XDG_RUNTIME_DIR/colony/ and prints Waybar-style JSON:
// {"text","tooltip","class","gates","runs","windows"}. Uses only the documented
// custom-module contract (bar.foreground / urgent / fontFamily / barSize / run /
// showTooltip / hideTooltip) and Quickshell.Io.
import QtQuick
import Quickshell.Io

Item {
  id: root
  property var bar
  property string moduleName
  property var settings

  property int gates: 0
  property int runs: 0
  property int windows: 0
  property string tip: "Colony"

  implicitWidth: label.implicitWidth + 12
  implicitHeight: root.bar ? root.bar.barSize : 26
  opacity: windows > 0 ? 1.0 : 0.5

  function apply(text) {
    try {
      const s = JSON.parse(text)
      root.gates = s.gates || 0
      root.runs = s.runs || 0
      root.windows = s.windows || 0
      root.tip = s.tooltip || "Colony"
    } catch (e) {
      root.windows = 0
      root.tip = "Colony: status unavailable"
    }
  }

  Process {
    id: statusProc
    command: ["colony", "status", "--bar"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.apply(text)
    }
  }

  Timer {
    interval: 3000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: if (!statusProc.running) statusProc.running = true
  }

  Text {
    id: label
    anchors.centerIn: parent
    // Nerd Font nf-md-robot (U+F06A9, as a surrogate pair) and the open gate count.
    text: root.gates > 0 ? "\uDB81\uDEA9 " + root.gates : "\uDB81\uDEA9"
    color: root.bar ? (root.gates > 0 ? root.bar.urgent : root.bar.foreground) : "white"
    font.family: root.bar ? root.bar.fontFamily : "monospace"
    font.pixelSize: 12
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    acceptedButtons: Qt.LeftButton | Qt.RightButton
    onEntered: if (root.bar) root.bar.showTooltip(root, root.tip)
    onExited: if (root.bar) root.bar.hideTooltip(root)
    onClicked: function(mouse) {
      if (!root.bar) return
      if (mouse.button === Qt.LeftButton && root.gates > 0) root.bar.run("colony --inbox")
      else root.bar.run("colony")
    }
  }
}
