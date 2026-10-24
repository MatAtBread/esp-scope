#include <inttypes.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_continuous.h"
#include "esp_event.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "wifi_manager.h"
#include "nvs_flash.h"

// Tag for logging
static const char* TAG = "ESP-SCOPE";

// Embedded index.html
extern const uint8_t index_html_start[] asm("_binary_index_html_start");
extern const uint8_t index_html_end[] asm("_binary_index_html_end");
extern const uint8_t index_js_start[] asm("_binary_index_js_start");
extern const uint8_t index_js_end[] asm("_binary_index_js_end");

// Forward declarations
static void start_webserver(void);

// ADC Configuration
#define ADC_UNIT ADC_UNIT_1
#define ADC_CONV_MODE ADC_CONV_SINGLE_UNIT_1
#define ADC_BIT_WIDTH ADC_BITWIDTH_12
#define SCOPE_CHANNEL ((adc_channel_t)CONFIG_SCOPE_ADC_CHANNEL)
#define SCOPE_CHANNEL2 ((adc_channel_t)CONFIG_SCOPE_ADC_CHANNEL2)
#define TEST_GPIO CONFIG_SCOPE_TEST_GPIO

#define ADC_OUTPUT_TYPE ADC_DIGI_OUTPUT_FORMAT_TYPE2
#define ADC_GET_DATA(p_data) ((p_data)->type2.data)

/*
 * Web Server Configuration
 */
static httpd_handle_t s_server = NULL;
static bool is_ap = false;
#define ADC_READ_LEN 4096

static adc_continuous_handle_t adc_handle = NULL;

// Single client support for simplicity, or use a list for multiple
static int s_ws_client_fd = -1;

// Global configuration state
static volatile bool s_reconfig_needed = false;
static uint32_t s_sample_rate = 10000;
static adc_atten_t s_atten = ADC_ATTEN_DB_12;
static adc_bitwidth_t s_bit_width = ADC_BIT_WIDTH;
static uint16_t s_test_hz = 100;
static uint8_t s_channels = 1;  // 1 = CH1 only, 2 = CH1 + CH2 interleaved

// Forward declarations
static void continuous_adc_init(adc_channel_t* channel, uint8_t channel_num,
                                adc_continuous_handle_t* out_handle);
static esp_err_t ws_handler(httpd_req_t* req);

// Helper to calculate optimal buffer size (approx 50ms latency, max 4096, aligned to 4)
static uint32_t get_optimal_buffer_size(uint32_t sample_rate) {
  uint32_t bytes_per_sec = sample_rate * sizeof(adc_digi_output_data_t);
  uint32_t target_size = bytes_per_sec / 50;  // 20ms (50Hz)

  // Clamp to min/max
  if (target_size < 128) target_size = 128;
  if (target_size > ADC_READ_LEN) target_size = ADC_READ_LEN;

  // Align to 4 bytes
  return (target_size + 3) & ~3;
}

/*
 * Task to read from ADC Continuous driver
 */
static void adc_read_task(void* arg) {
  esp_err_t ret;
  uint32_t ret_num = 0;
  uint8_t result[ADC_READ_LEN] = {0};
  memset(result, 0xcc, ADC_READ_LEN);

  // ADC Init (Moved from app_main). Channels are set in menuconfig (espScope).
  adc_channel_t channel[2] = {SCOPE_CHANNEL, SCOPE_CHANNEL2};
  continuous_adc_init(channel, s_channels, &adc_handle);
  ESP_ERROR_CHECK(adc_continuous_start(adc_handle));

  while (1) {
    if (s_reconfig_needed) {
      ESP_LOGI(TAG, "Reconfiguring ADC...");
      if (adc_handle) {
        ESP_LOGI(TAG, "Stopping ADC...");
        ret = adc_continuous_stop(adc_handle);
        if (ret != ESP_OK) {
          ESP_LOGE(TAG, "adc_continuous_stop failed: %s", esp_err_to_name(ret));
        }
        ESP_LOGI(TAG, "Deinitializing ADC...");
        ret = adc_continuous_deinit(adc_handle);
        if (ret != ESP_OK) {
          ESP_LOGE(TAG, "adc_continuous_deinit failed: %s",
                   esp_err_to_name(ret));
        }
        adc_handle = NULL;
      }

      // Small delay to ensure hardware state clears
      vTaskDelay(pdMS_TO_TICKS(20));

      // Update global defaults for next init
      // Note: In a robust app, we should pass these to init function
      // For now, we rely on the global s_sample_rate etc being read by init
      continuous_adc_init(channel, s_channels, &adc_handle);

      ESP_LOGI(TAG, "Starting ADC...");
      ESP_ERROR_CHECK(adc_continuous_start(adc_handle));
      ESP_LOGI(TAG, "ADC Reconfigured and Restarted");
      s_reconfig_needed = false;
    }

    ret = adc_continuous_read(adc_handle, result, get_optimal_buffer_size(s_sample_rate), &ret_num, 0);
    if (ret == ESP_OK) {
      // ESP_LOGI(TAG, "ret is %x, ret_num is %"PRIu32" bytes", ret, ret_num);

      // OPTIMIZED BATCH SENDING
      // We have `ret_num` bytes of data in `result`.
      // It contains `adc_digi_output_data_t` structs (4 bytes each).
      // We want to extract just the data (12-16 bits) to save bandwidth?
      // The original code was: `uint16_t val = (uint16_t)data;` and sent that.
      // So we have 1/2 the size.

      if (s_ws_client_fd != -1) {
        // Allocate a small temp buffer on stack or static to avoid malloc in loop
        // ret_num is up to ADC_READ_LEN (1024). 1024 / 4 = 256 samples.
        // 256 * 2 bytes = 512 bytes output. Stack safe.
        uint16_t out_buf[ADC_READ_LEN / sizeof(adc_digi_output_data_t)];
        int out_idx = 0;

        // Each sample: bits 0-11 = ADC code, bits 12-15 = scope channel (0 = CH1, 1 = CH2)
        bool dual = s_channels == 2;
        for (int i = 0; i < ret_num; i += sizeof(adc_digi_output_data_t)) {
          adc_digi_output_data_t* p = (adc_digi_output_data_t*)&result[i];
          uint32_t val = ADC_GET_DATA(p) & 0xfff;
          if (dual && p->type2.channel == SCOPE_CHANNEL2) val |= 1 << 12;
          out_buf[out_idx++] = (uint16_t)val;
        }

        if (out_idx > 0) {
          httpd_ws_frame_t ws_frame = {
              .final = true,
              .fragmented = false,
              .type = HTTPD_WS_TYPE_BINARY,
              .payload = (uint8_t*)out_buf,
              .len = out_idx * sizeof(uint16_t)};

          // Non-blocking send (best effort)
          esp_err_t ret_ws = httpd_ws_send_frame_async(s_server, s_ws_client_fd, &ws_frame);
          if (ret_ws != ESP_OK) {
            ESP_LOGW(TAG, "dropped: %s", esp_err_to_name(ret_ws));

            // Invalidate FD if it's no longer valid (client disconnected)
            if (ret_ws == ESP_ERR_INVALID_ARG || ret_ws == ESP_FAIL) {
              s_ws_client_fd = -1;
            }
          }
        }
      }

      /**
       * Yield check
       */
      taskYIELD(); /* Explicit yield to let WiFi stack run if needed, though send_async should handle it */
    } else if (ret == ESP_ERR_TIMEOUT) {
      // We try to read `ADC_READ_LEN` until API returns timeout, which means
      // there's no available data
      vTaskDelay(pdMS_TO_TICKS(10));
    }
  }
}

static void continuous_adc_init(adc_channel_t* channel, uint8_t channel_num,
                                adc_continuous_handle_t* out_handle) {
  uint32_t frame_size = get_optimal_buffer_size(s_sample_rate);
  ESP_LOGI(TAG, "Dynamic Buffer Size: %lu bytes", frame_size);

  adc_continuous_handle_cfg_t adc_config = {
      .max_store_buf_size = 16384,
      .conv_frame_size = frame_size,
  };
  ESP_ERROR_CHECK(adc_continuous_new_handle(&adc_config, out_handle));

  // Update the global read length used by the task (hacky but simple for now)
  // Ideally return it, but our init function signature is fixed.
  // We can rely on get_optimal_buffer_size(s_sample_rate) being consistent.

  adc_continuous_config_t dig_cfg = {
      .sample_freq_hz = s_sample_rate,
      .conv_mode = ADC_CONV_MODE,
      .format = ADC_OUTPUT_TYPE,
  };

  adc_digi_pattern_config_t adc_pattern[SOC_ADC_PATT_LEN_MAX] = {0};
  dig_cfg.pattern_num = channel_num;

  for (int i = 0; i < channel_num; i++) {
    adc_pattern[i].atten = s_atten;
    adc_pattern[i].channel = channel[i];
    adc_pattern[i].unit = ADC_UNIT;
    adc_pattern[i].bit_width = s_bit_width;

    ESP_LOGI(TAG, "adc_pattern[%d].atten is :%" PRIx8, i, adc_pattern[i].atten);
    ESP_LOGI(TAG, "adc_pattern[%d].channel is :%" PRIx8, i,
             adc_pattern[i].channel);
    ESP_LOGI(TAG, "adc_pattern[%d].unit is :%" PRIx8, i, adc_pattern[i].unit);
  }
  dig_cfg.adc_pattern = adc_pattern;
  ESP_ERROR_CHECK(adc_continuous_config(*out_handle, &dig_cfg));
}
static bool ledc_inited = false;
static void start_test_signal(uint32_t hz) {
  if (ledc_inited) {
    ESP_LOGI(TAG, "De-init test signal");
    gpio_reset_pin(TEST_GPIO);

    // Stop the PWM signal on channel 0
    ledc_stop(LEDC_LOW_SPEED_MODE, LEDC_CHANNEL_0, 0);

    // Reset the timer configuration
    ledc_timer_rst(LEDC_LOW_SPEED_MODE, LEDC_TIMER_0);

    // (Optional) Uninstall fade functionality if used
    ledc_fade_func_uninstall();
  }
  ESP_LOGI(TAG, "Starting test signal at %" PRIu32 " Hz on GPIO %d", hz, TEST_GPIO);
  // Highest duty resolution the 80MHz clock allows at this frequency (so >4.8kHz works too)
  uint32_t res = ledc_find_suitable_duty_resolution(80000000, hz);
  if (res > LEDC_TIMER_14_BIT) res = LEDC_TIMER_14_BIT;
  if (res < 1) res = 1;
  ledc_timer_config_t ledc_timer = {
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .duty_resolution = (ledc_timer_bit_t)res,
      .timer_num = LEDC_TIMER_0,
      .freq_hz = hz,
      .clk_cfg = LEDC_AUTO_CLK};
  ledc_channel_config_t ledc_channel = {
      .gpio_num = TEST_GPIO,
      .speed_mode = LEDC_LOW_SPEED_MODE,
      .channel = LEDC_CHANNEL_0,
      .timer_sel = LEDC_TIMER_0,
      .duty = 1 << (ledc_timer.duty_resolution - 1),  // 50% duty cycle
      .hpoint = 0};

  // Initialize the PWM
  ledc_timer_config(&ledc_timer);
  ledc_channel_config(&ledc_channel);
  // Start the PWM signal
  ledc_set_duty(ledc_channel.speed_mode, ledc_channel.channel, ledc_channel.duty);  // 50% duty cycle
  ledc_update_duty(ledc_channel.speed_mode, ledc_channel.channel);
  ledc_inited = true;
}

static void show_status_led() {
  #if defined(CONFIG_BSP_CONFIG_GPIO) && CONFIG_BSP_CONFIG_GPIO >= 0
  gpio_config_t rst_conf = {
      .pin_bit_mask = (1ULL << CONFIG_BSP_CONFIG_GPIO),
      .mode = GPIO_MODE_INPUT,
      .pull_up_en = GPIO_PULLUP_ENABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE
  };
  gpio_config(&rst_conf);
  #endif

  int64_t reset_pressed_time = 0;
  while (true) {
    int64_t now = esp_timer_get_time() / 1000;
#if defined(CONFIG_LED_BUILTIN) && CONFIG_LED_BUILTIN >= 0
    if (is_ap) {
      vTaskDelay(pdMS_TO_TICKS(500));
      gpio_set_level(CONFIG_LED_BUILTIN, 1);
      vTaskDelay(pdMS_TO_TICKS(500));
    } else {
      if (is_connected()) {
        vTaskDelay(pdMS_TO_TICKS(100));
        gpio_set_level(CONFIG_LED_BUILTIN, 1);
      }
      vTaskDelay(pdMS_TO_TICKS(s_ws_client_fd == -1 ? 900 : 200));
    }
    gpio_set_level(CONFIG_LED_BUILTIN, 0);
#else
    vTaskDelay(pdMS_TO_TICKS(1000));
#endif

// Check Reset Pin
#if defined(CONFIG_BSP_CONFIG_GPIO) && CONFIG_BSP_CONFIG_GPIO >= 0
    if (!is_ap && gpio_get_level(CONFIG_BSP_CONFIG_GPIO) == 0) {
      if (now - reset_pressed_time > 1000) {
        ESP_LOGW(TAG, "Reset to WiFi-AP mode triggered via GPIO %d", CONFIG_BSP_CONFIG_GPIO);
        wifi_manager_erase_config();
        esp_restart();
      } else {
        reset_pressed_time = now;
      }
    } else {
      reset_pressed_time = 0;
    }
#endif
  }
}

void app_main(void) {
  // Initialize NVS
  esp_err_t ret = nvs_flash_init();
  if (ret == ESP_ERR_NVS_NO_FREE_PAGES ||
      ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    ret = nvs_flash_init();
  }
  ESP_ERROR_CHECK(ret);

#if defined(CONFIG_LED_BUILTIN) && CONFIG_LED_BUILTIN >= 0
  gpio_config_t led_io_conf = {
      .pin_bit_mask = (1ULL << CONFIG_LED_BUILTIN),
      .mode = GPIO_MODE_OUTPUT,
      .pull_up_en = GPIO_PULLUP_DISABLE,
      .pull_down_en = GPIO_PULLDOWN_DISABLE,
      .intr_type = GPIO_INTR_DISABLE};
  gpio_config(&led_io_conf);
  gpio_set_level(CONFIG_LED_BUILTIN, 0);
#endif

#ifdef CONFIG_BOARD_HAS_SPECIFIC_INIT
#include CONFIG_BOARD_SPECIFIC_INIT
#endif

  is_ap = wifi_manager_init_wifi();

  start_test_signal(100);
  xTaskCreate(adc_read_task, "adc_read_task", 8192 + ADC_READ_LEN, NULL, 5, NULL);

  // Wait for WiFi connection (Not strict blocking anymore, manager handles it)
  // But let's keep it to print status
  // Note: s_wifi_event_group is local to this file, we removed it in place of manager's.
  // Proper way: expose event group from manager or just dont block here.
  // For now, let's just proceed. The webserver will start and wait for connections.

  start_webserver();
  show_status_led();
}


/*
 * WebSocket Handler
 */
static esp_err_t ws_handler(httpd_req_t* req) {
  if (req->method == HTTP_GET) {
    // Handshake
    return ESP_OK;
  }

  httpd_ws_frame_t ws_pkt;
  uint8_t* buf = NULL;
  memset(&ws_pkt, 0, sizeof(httpd_ws_frame_t));
  ws_pkt.type = HTTPD_WS_TYPE_TEXT;

  // Get frame len
  esp_err_t ret = httpd_ws_recv_frame(req, &ws_pkt, 0);
  if (ret != ESP_OK)
    return ret;

  if (ws_pkt.len) {
    buf = calloc(1, ws_pkt.len + 1);
    if (buf == NULL)
      return ESP_ERR_NO_MEM;
    ws_pkt.payload = buf;
    ret = httpd_ws_recv_frame(req, &ws_pkt, ws_pkt.len);
    if (ret != ESP_OK) {
      free(buf);
      return ret;
    }

    // Check for "hello"
    if (ws_pkt.type == HTTPD_WS_TYPE_TEXT &&
        strcmp((char*)ws_pkt.payload, "hello") == 0) {
      ESP_LOGI(TAG, "New WS client connected, fd=%d", httpd_req_to_sockfd(req));
      s_ws_client_fd = httpd_req_to_sockfd(req);
    }
    free(buf);
  }
  return ESP_OK;
}

/*
 * Control Params Handler (POST /params)
 */
static esp_err_t params_handler(httpd_req_t* req) {
  char buf[256];
  int ret, remaining = req->content_len;
  if (remaining >= sizeof(buf)) {
    httpd_resp_send_500(req);
    return ESP_FAIL;
  }

  ret = httpd_req_recv(req, buf, remaining);
  if (ret <= 0)
    return ESP_FAIL;
  buf[ret] = '\0';

  cJSON* root = cJSON_Parse(buf);
  if (root) {
    cJSON* sample_rate = cJSON_GetObjectItem(root, "sample_rate");
    if (sample_rate) {
      uint32_t rate = sample_rate->valueint;
      if (rate < SOC_ADC_SAMPLE_FREQ_THRES_LOW) rate = SOC_ADC_SAMPLE_FREQ_THRES_LOW;
      if (rate > SOC_ADC_SAMPLE_FREQ_THRES_HIGH) rate = SOC_ADC_SAMPLE_FREQ_THRES_HIGH;
      if (s_sample_rate != rate) {
        s_reconfig_needed = true;
        s_sample_rate = rate;
      }
    }
    cJSON* atten = cJSON_GetObjectItem(root, "atten");
    if (atten && atten->valueint >= ADC_ATTEN_DB_0 && atten->valueint <= ADC_ATTEN_DB_12 &&
        s_atten != (adc_atten_t)atten->valueint) {
      s_reconfig_needed = true;
      s_atten = (adc_atten_t)atten->valueint;
    }
    cJSON* bit_width = cJSON_GetObjectItem(root, "bit_width");
    if (bit_width && s_bit_width != (adc_bitwidth_t)bit_width->valueint) {
      s_reconfig_needed = true;
      s_bit_width = (adc_bitwidth_t)bit_width->valueint;
    }
    cJSON* channels = cJSON_GetObjectItem(root, "channels");
    if (channels && (channels->valueint == 1 || channels->valueint == 2) &&
        s_channels != channels->valueint) {
      s_reconfig_needed = true;
      s_channels = channels->valueint;
    }
    cJSON* test_hz = cJSON_GetObjectItem(root, "test_hz");
    if (test_hz && test_hz->valueint >= 1 && test_hz->valueint <= 40000) {
      if (s_test_hz != (uint16_t)test_hz->valueint) {
        s_test_hz = (uint16_t)test_hz->valueint;
        start_test_signal(s_test_hz);
      }
    }

    ESP_LOGI(TAG, "Config Request: Rate=%lu, Atten=%d, Width=%d, TestHz=%u, s_reconfig_needed=%d", s_sample_rate,
             s_atten, s_bit_width, s_test_hz,
             s_reconfig_needed);

    cJSON_Delete(root);
  }

  httpd_resp_send(req, "OK", 2);
  return ESP_OK;
}

/*
 * Device info + ADC calibration table (GET /info)
 * The browser converts raw ADC codes to volts by interpolating "mv", which holds
 * the calibrated millivolts for raw codes 0, 128, 256 ... 4096 (33 points).
 */
#define CAL_POINTS 33
static adc_cali_handle_t s_cali[ADC_ATTEN_DB_12 + 1];
static bool s_cali_tried[ADC_ATTEN_DB_12 + 1];

static adc_cali_handle_t get_cali(adc_atten_t atten) {
  if (atten > ADC_ATTEN_DB_12) return NULL;
  if (!s_cali_tried[atten]) {
    s_cali_tried[atten] = true;
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t cfg = {
        .unit_id = ADC_UNIT, .chan = SCOPE_CHANNEL, .atten = atten, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_curve_fitting(&cfg, &s_cali[atten]) != ESP_OK) s_cali[atten] = NULL;
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_line_fitting_config_t cfg = {
        .unit_id = ADC_UNIT, .atten = atten, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_line_fitting(&cfg, &s_cali[atten]) != ESP_OK) s_cali[atten] = NULL;
#endif
    ESP_LOGI(TAG, "ADC calibration for atten %d: %s", atten, s_cali[atten] ? "OK" : "not available");
  }
  return s_cali[atten];
}

static esp_err_t info_handler(httpd_req_t* req) {
  adc_atten_t atten = s_atten;
  int adc_gpio = -1, adc_gpio2 = -1;
  adc_continuous_channel_to_io(ADC_UNIT, SCOPE_CHANNEL, &adc_gpio);
  adc_continuous_channel_to_io(ADC_UNIT, SCOPE_CHANNEL2, &adc_gpio2);

  cJSON* root = cJSON_CreateObject();
  cJSON_AddStringToObject(root, "target", CONFIG_IDF_TARGET);
  cJSON_AddNumberToObject(root, "adc_gpio", adc_gpio);
  cJSON_AddNumberToObject(root, "adc_gpio2", adc_gpio2);
  cJSON_AddNumberToObject(root, "channels", s_channels);
  cJSON_AddNumberToObject(root, "test_gpio", TEST_GPIO);
  cJSON_AddNumberToObject(root, "rate_min", SOC_ADC_SAMPLE_FREQ_THRES_LOW);
  cJSON_AddNumberToObject(root, "rate_max", SOC_ADC_SAMPLE_FREQ_THRES_HIGH);
  cJSON_AddNumberToObject(root, "sample_rate", s_sample_rate);
  cJSON_AddNumberToObject(root, "atten", atten);
  cJSON_AddNumberToObject(root, "test_hz", s_test_hz);

  adc_cali_handle_t cali = get_cali(atten);
  cJSON_AddBoolToObject(root, "calibrated", cali != NULL);
  if (cali) {
    cJSON* mv = cJSON_AddArrayToObject(root, "mv");
    for (int i = 0; i < CAL_POINTS; i++) {
      int raw = i * 128;
      if (raw > 4095) raw = 4095;
      int v = 0;
      adc_cali_raw_to_voltage(cali, raw, &v);
      cJSON_AddItemToArray(mv, cJSON_CreateNumber(v));
    }
  }

  char* json = cJSON_PrintUnformatted(root);
  cJSON_Delete(root);
  httpd_resp_set_type(req, "application/json");
  httpd_resp_set_hdr(req, "Cache-Control", "no-store");
  httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
  free(json);
  return ESP_OK;
}

static const httpd_uri_t uri_info = {
    .uri = "/info", .method = HTTP_GET, .handler = info_handler, .user_ctx = NULL};

static const httpd_uri_t uri_ws = {.uri = "/signal",
                                   .method = HTTP_GET,
                                   .handler = ws_handler,
                                   .user_ctx = NULL,
                                   .is_websocket = true};

static const httpd_uri_t uri_params = {.uri = "/params",
                                       .method = HTTP_POST,
                                       .handler = params_handler,
                                       .user_ctx = NULL};

/* Handler for serving index.html */
static esp_err_t index_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, "text/html");
  httpd_resp_set_hdr(req, "Content-Type", "text/html; charset=utf-8");
  uint32_t len = index_html_end - index_html_start;
  // Workaround for some build systems adding null byte
  while (len && index_html_start[len - 1] == 0) len--;
  httpd_resp_send(req, (const char*)index_html_start, len);
  return ESP_OK;
}

static const httpd_uri_t uri_index = {
    .uri = "/", .method = HTTP_GET, .handler = index_handler, .user_ctx = NULL};

/* Handler for serving index.js */
static esp_err_t index_js_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, "text/javascript");
  httpd_resp_set_hdr(req, "Content-Type", "text/javascript; charset=utf-8");
  uint32_t len = index_js_end - index_js_start;
  // Workaround for some build systems adding null byte
  while (len && index_js_start[len - 1] == 0) len--;
  httpd_resp_send(req, (const char*)index_js_start, len);
  return ESP_OK;
}

static const httpd_uri_t uri_index_js = {
    .uri = "/index.js", .method = HTTP_GET, .handler = index_js_handler, .user_ctx = NULL};

static const char *bye = "<head></head><body style='font-family: -apple-system, BlinkMacSystemFont, &quot;Segoe UI&quot;, Roboto, Helvetica, Arial, sans-serif;\n  background: #1a1a1a;\n  color: #e0e0e0;'><h1>Bye!</h1>Press \"reset\" on your esp-scope to start it up again</body>";

static esp_err_t power_handler(httpd_req_t* req) {
  httpd_resp_set_type(req, "text/html");
  httpd_resp_set_hdr(req, "Content-Type", "text/html; charset=utf-8");
  httpd_resp_send(req, bye, HTTPD_RESP_USE_STRLEN);

  // delay to ensure network is flushed
  vTaskDelay(pdMS_TO_TICKS(200));

  esp_deep_sleep_start();
  return ESP_OK;
}

static const httpd_uri_t uri_power = {
    .uri = "/poweroff", .method = HTTP_GET, .handler = power_handler, .user_ctx = NULL};

/* Error handler for 404 - Redirects to captive portal */
static esp_err_t http_404_error_handler(httpd_req_t *req, httpd_err_code_t err)
{
    /* Set status 302 Redirect */
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "/");
    httpd_resp_send(req, NULL, 0); // No body needed
    return ESP_OK;
}

static void start_webserver(void) {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.lru_purge_enable = true;
  config.max_uri_handlers = 16;

  ESP_LOGI(TAG, "Starting webserver on port: '%d'", config.server_port);
  if (httpd_start(&s_server, &config) == ESP_OK) {
    ESP_LOGI(TAG, "Registering URI handlers");
    httpd_register_uri_handler(s_server, &uri_index);
    httpd_register_uri_handler(s_server, &uri_index_js);
    httpd_register_uri_handler(s_server, &uri_ws);
    httpd_register_uri_handler(s_server, &uri_params);
    httpd_register_uri_handler(s_server, &uri_info);

    // Register WiFi Manager endpoints
    wifi_manager_register_uri(s_server);
    httpd_register_uri_handler(s_server, &uri_power);

    // Register 404 handler for Captive Portal redirection
    httpd_register_err_handler(s_server, HTTPD_404_NOT_FOUND, http_404_error_handler);
  } else {
    ESP_LOGI(TAG, "Error starting server!");
  }
}
