# ESP-Scope

## Overview
ESP-Scope is a web-based oscilloscope built using the ESP-IDF framework. It allows users to visualize analog signals in real-time through a web browser. The project leverages the ESP32's ADC capabilities and serves a web interface for signal visualization. It contains complete source code and 3D design for a case for the Seeed XIAO ESP32C6.

This project was written in part to test AI code generators and see if they're any good. Much of the code was written by Google Antigravity using Gemini 3, with refinements, hints and top and overall design specified by a human. The whole app was up and running a few hours and finished, including 3D design in a weekend.

![esp-scope](screenshot.png)

## Features
- Real-time signal visualization on a web browser.
- Adjustable sample rate (1-83333 Hz) and attenuation.
- Crosshair functionality for precise measurements.
- Adjustable trigger level.
- Test signal generation.
- Reset functionality to clear settings and reload the interface.
- Power off from the browser.

## Getting Started

### Prerequisites
- ESP32 development board.
- [ESP-IDF](https://github.com/espressif/esp-idf) installed and configured.
- USB cable to connect the ESP32 to your computer.
- A web browser (e.g., Chrome, Firefox).

### Downloading the Project
1. Clone the repository:
   ```bash
   git clone https://github.com/MatAtBread/esp-scope.git
   ```
2. Navigate to the project directory:
   ```bash
   cd esp-scope
   ```

### Building and Flashing

If you have the esp-idf VSCode extension, just click on the flame to build, flash & monitor. Use the config settings for "espScope" to specify GPIO pins for the LED & "AP-Mode" button, and if necessary a board-specific setup file (one is provided for the Seeed Studio XIAO ESP32C6 to enable the internal ceramic antenna).

1. Set up the ESP-IDF environment:
   ```bash
   . $IDF_PATH/export.sh
   ```
2. Configure the project:
   ```bash
   idf.py menuconfig
   ```
3. Build the project:
   ```bash
   idf.py build
   ```
4. Flash the firmware to the ESP32:
   ```bash
   idf.py -p [PORT] flash
   ```
   Replace `[PORT]` with the serial port of your ESP32 (e.g., `/dev/ttyUSB0` or `COM3`).
5. Monitor the serial output:
   ```bash
   idf.py monitor
   ```

### Accessing the Web Interface

If your DHCP server supports it (most seem to), the app sets its hostname and you can just navigate to http://esp-scope (you may have/need a default domain extension)

1. After flashing, ESP-SCOPE will start as a WiFi access point. Connect to it to access the UI.
2. If desired, click the "WiFi" button and set your SSID & WiFi password. The device will reboot and join your network. Pressing and holding the GPIO "AP-Mode" button will erase the WiFi credentials and return to Access Point mode.
3. Open a web browser and navigate to "http://esp-scope" (you may have/need a default domain extension).
4. Use the web interface to:
   - Adjust settings like sample rate, attenuation & the test signal frequency.
   - Visualize signals in real-time.
   - Reset the interface using the "Reset" button.
   - Re-configure the WiFi using the "WiFi" button.
   - Power off the device

### Attaching hardware

The displayed signal is sampled from ADC0. The test signal is output on D1. The default GPIOs for the LED and "AP-Mode" button are 15 and 9 respectively (hard-wired on an Seeed XIAO ESP32C6 to the yellow LED and "Boot" button).

## 3D design

The 3D design is a two part case with space for a AA-battery (Li-poly 3.7v, which can connect directly to a Seeed XIAO ESP device) clips and holes for the USB-C connector and "ground", "signal" and "test" connections using standard 2.54mm pitch, easily cut from jumpers and soldered directly to the Seeed XIAO. The 3D design was done using Fusion 360 and printed on a Bambu Labs A1 Mini in 30 minutes.

![esp-scope](esp-scope-3d.jpg)

## License
This project is licensed under the MIT License. See the LICENSE file for details.

## Acknowledgments
- Built using the ESP-IDF framework by Espressif Systems.
- Gemini 3.
