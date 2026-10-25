// Colony bar widget for omarchy-shell (installed by Colony: More → Omarchy integration…).
// Polls `colony status --bar`, which aggregates the status files the running Colony
// windows keep in $XDG_RUNTIME_DIR/colony/ and prints Waybar-style JSON:
// {"text","tooltip","class","gates","runs","windows"}. Uses only the documented
// custom-module contract (bar.foreground / urgent / fontFamily / barSize / run /
// showTooltip / hideTooltip) and Quickshell.Io. The icon is the Colony mark
// (colony-icon.svg, written next to this file), white and tinted with the bar's
// foreground, or its urgent colour while a gate waits (the Tray's MultiEffect pattern).
import QtQuick
import QtQuick.Effects
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

  readonly property color tint: root.bar ? (root.gates > 0 ? root.bar.urgent : root.bar.foreground) : "white"

  implicitWidth: content.implicitWidth + 12
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

  Row {
    id: content
    anchors.centerIn: parent
    spacing: 4

    Item {
      width: 21
      height: 16
      anchors.verticalCenter: parent.verticalCenter

      Image {
        id: mark
        anchors.fill: parent
        source: Qt.resolvedUrl("colony-icon.svg")
        fillMode: Image.PreserveAspectFit
        smooth: true
        // Decode at physical pixels so the mark stays sharp on HiDPI.
        sourceSize.width: Math.round(width * Screen.devicePixelRatio)
        sourceSize.height: Math.round(height * Screen.devicePixelRatio)
        // Kept as a hidden layer so the effect can sample it as a texture.
        visible: false
        layer.enabled: true
      }

      MultiEffect {
        anchors.fill: mark
        source: mark
        visible: mark.status === Image.Ready
        colorization: 1.0
        colorizationColor: root.tint
      }

      // Without the SVG (an install from before it shipped): the Nerd Font ringed planet.
      Text {
        anchors.centerIn: parent
        visible: mark.status !== Image.Ready
        text: "\ue22e"
        color: root.tint
        font.family: root.bar ? root.bar.fontFamily : "monospace"
        font.pixelSize: 14
      }
    }

    Text {
      id: label
      anchors.verticalCenter: parent.verticalCenter
      visible: root.gates > 0
      text: root.gates
      color: root.tint
      font.family: root.bar ? root.bar.fontFamily : "monospace"
      font.pixelSize: 12
    }
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
