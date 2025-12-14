#include "wifi_manager.h"
#include <string.h>
#include "esp_mac.h"
#include <sys/param.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "lwip/err.h"
#include "lwip/sys.h"
#include "lwip/sockets.h"
#include "cJSON.h"

// Logs
static const char *TAG = "WIFI_MGR";

// Event Group
static EventGroupHandle_t s_wifi_event_group;
#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT      BIT1

// Server Handle for registering handlers
static httpd_handle_t s_server_handle = NULL;

// DNS Port
#define DNS_PORT 53

// SoftAP Config
#define AP_SSID "ESP-Scope"
#define AP_PASS ""

// Forward decls

static void wifi_init_softap(void);
static void wifi_init_station(const char* ssid, const char* pass);

// NVS Keys
#define NVS_NAMESPACE "wifi_cfg"
#define NVS_KEY_SSID "ssid"
#define NVS_KEY_PASS "pass"

// WiFi Event Handler
static void event_handler(void *arg, esp_event_base_t event_base,
                          int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        ESP_LOGI(TAG, "Retry connecting to AP...");
        esp_wifi_connect();
        // In a real product, we might count retries and switch to AP mode if failing.
        // For now, infinite retry is simple.
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STACONNECTED) {
        wifi_event_ap_staconnected_t *event = (wifi_event_ap_staconnected_t *)event_data;
        ESP_LOGI(TAG, "station "MACSTR" join, AID=%d", MAC2STR(event->mac), event->aid);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_AP_STADISCONNECTED) {
        wifi_event_ap_stadisconnected_t *event = (wifi_event_ap_stadisconnected_t *)event_data;
        ESP_LOGI(TAG, "station "MACSTR" leave, AID=%d", MAC2STR(event->mac), event->aid);
    }
}

// -------------------------------------------------------------------------
// DNS Server Task (Captive Portal)
// -------------------------------------------------------------------------
static void dns_server_task(void *pvParameters) {
    int sock;
    struct sockaddr_in server_addr;
    struct sockaddr_in client_addr;
    socklen_t client_addr_len = sizeof(client_addr);
    uint8_t rx_buffer[128];
    uint8_t tx_buffer[128];

    // Create UDP socket
    sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP);
    if (sock < 0) {
        ESP_LOGE(TAG, "Unable to create DNS socket: errno %d", errno);
        vTaskDelete(NULL);
    }

    server_addr.sin_family = AF_INET;
    server_addr.sin_port = htons(DNS_PORT);
    server_addr.sin_addr.s_addr = htonl(INADDR_ANY);

    if (bind(sock, (struct sockaddr *)&server_addr, sizeof(server_addr)) < 0) {
        ESP_LOGE(TAG, "Socket unable to bind: errno %d", errno);
        close(sock);
        vTaskDelete(NULL);
    }

    ESP_LOGI(TAG, "DNS Server started on port 53");

    while (1) {
        int len = recvfrom(sock, rx_buffer, sizeof(rx_buffer), 0, (struct sockaddr *)&client_addr, &client_addr_len);
        if (len < 0) {
            ESP_LOGE(TAG, "recvfrom failed: errno %d", errno);
            break;
        }

        // Basic DNS Header Parsing
        // We just want to spoof the answer for any A-record query.
        // Transaction ID: bytes 0-1 (Copy)
        // Flags: bytes 2-3 (Standard Query -> Standard Response)

        if (len > 12) {
             // Copy Transaction ID
            tx_buffer[0] = rx_buffer[0];
            tx_buffer[1] = rx_buffer[1];

            // Flags: Response (QR=1), Opcode=0, AA=0, TC=0, RD=1, RA=0, Z=0, RCODE=0
            // 0x8180 (Standard query response, No error)
            tx_buffer[2] = 0x81;
            tx_buffer[3] = 0x80;

            // Questions Count: Copy (should be 1)
            tx_buffer[4] = rx_buffer[4];
            tx_buffer[5] = rx_buffer[5];

            // Answer RRs: 1
            tx_buffer[6] = 0x00;
            tx_buffer[7] = 0x01;

            // Authority RRs: 0
            tx_buffer[8] = 0x00;
            tx_buffer[9] = 0x00;

            // Additional RRs: 0
            tx_buffer[10] = 0x00;
            tx_buffer[11] = 0x00;

            // Copy Question Section
            // In a real server we'd parse this length. For simplicity in captive portal,
            // we assume the question fits in the buffer and just echo it.
            // Point to end of question to append answer.
            int question_len = len - 12;
            if (question_len > 0 && (12 + question_len + 16 < sizeof(tx_buffer))) {
                memcpy(&tx_buffer[12], &rx_buffer[12], question_len);

                // Answer Section
                int offset = 12 + question_len;

                // Name Pointer (0xC00C -> Point to start of packet header + 12 = start of question name)
                tx_buffer[offset++] = 0xC0;
                tx_buffer[offset++] = 0x0C;

                // Type: A (Host Address) = 1
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x01;

                // Class: IN (Internet) = 1
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x01;

                // TTL: 60 seconds
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x3C;

                // Data Length: 4 (IPv4)
                tx_buffer[offset++] = 0x00;
                tx_buffer[offset++] = 0x04;

                // Address: 192.168.4.1 (Default SoftAP IP)
                tx_buffer[offset++] = 192;
                tx_buffer[offset++] = 168;
                tx_buffer[offset++] = 4;
                tx_buffer[offset++] = 1;

                // Send
                sendto(sock, tx_buffer, offset, 0, (struct sockaddr *)&client_addr, client_addr_len);
            }
        }
    }
    close(sock);
    vTaskDelete(NULL);
}

// -------------------------------------------------------------------------
// Init Functions
// -------------------------------------------------------------------------
static void wifi_init_softap(void) {
    ESP_LOGI(TAG, "Starting SoftAP Provisioning Mode...");

    // Explicitly set mode to NULL first to ensure clean state
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));

    wifi_config_t wifi_config = {
        .ap = {
            .ssid = AP_SSID,
            .ssid_len = strlen(AP_SSID),
            .channel = 1,
            .password = AP_PASS,
            .max_connection = 4,
            .authmode = WIFI_AUTH_OPEN
        },
    };
    if (strlen(AP_PASS) == 0) {
        wifi_config.ap.authmode = WIFI_AUTH_OPEN;
    }

    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "SoftAP Started. SSID: %s", AP_SSID);

    // Start DNS Server Task
    xTaskCreate(dns_server_task, "dns_task", 2048, NULL, 5, NULL);
}

static void wifi_init_station(const char* ssid, const char* pass) {
    ESP_LOGI(TAG, "Starting Station Mode. Connecting to %s...", ssid);

    wifi_config_t wifi_config = {
        .sta = {
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };
    strncpy((char*)wifi_config.sta.ssid, ssid, sizeof(wifi_config.sta.ssid));
    strncpy((char*)wifi_config.sta.password, pass, sizeof(wifi_config.sta.password));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE)); // Maintain low jitter optimization
}

// -------------------------------------------------------------------------
// HTTP Handler: /api/save_wifi
// -------------------------------------------------------------------------
static esp_err_t save_wifi_handler(httpd_req_t *req) {
    char buf[200]; // reasonable limit for JSON
    int ret, remaining = req->content_len;
    if (remaining >= sizeof(buf)) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    ret = httpd_req_recv(req, buf, remaining);
    if (ret <= 0) return ESP_FAIL;
    buf[ret] = '\0';

    cJSON *root = cJSON_Parse(buf);
    if (root) {
        cJSON *ssid_item = cJSON_GetObjectItem(root, "ssid");
        cJSON *pass_item = cJSON_GetObjectItem(root, "password");

        if (cJSON_IsString(ssid_item) && (cJSON_IsString(pass_item))) {
            const char* ssid = ssid_item->valuestring;
            const char* pass = pass_item->valuestring;

            ESP_LOGI(TAG, "Saving WiFi Credentials: SSID=%s", ssid);

            // Save to NVS
            nvs_handle_t nvs_handle;
            esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs_handle);
            if (err == ESP_OK) {
                nvs_set_str(nvs_handle, NVS_KEY_SSID, ssid);
                nvs_set_str(nvs_handle, NVS_KEY_PASS, pass);
                nvs_commit(nvs_handle);
                nvs_close(nvs_handle);

                httpd_resp_send(req, "Saved. Rebooting...", HTTPD_RESP_USE_STRLEN);

                // Give time for response to flush
                vTaskDelay(pdMS_TO_TICKS(1000));
                esp_restart();
            } else {
                 ESP_LOGE(TAG, "NVS Open Failed");
                 httpd_resp_send_500(req);
            }
        }
        cJSON_Delete(root);
    }
    return ESP_OK;
}

static const httpd_uri_t uri_save_wifi = {
    .uri = "/api/save_wifi",
    .method = HTTP_POST,
    .handler = save_wifi_handler,
    .user_ctx = NULL
};

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

void wifi_manager_register_uri(httpd_handle_t server) {
    s_server_handle = server;
    if (s_server_handle) {
         httpd_register_uri_handler(s_server_handle, &uri_save_wifi);
    }
}

bool wifi_manager_init_wifi(void) {
    s_wifi_event_group = xEventGroupCreate();

    // 1. Netif Init (Common)
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(sta_netif, "esp-scope");
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL, NULL);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL, NULL);

    // 2. Check NVS
    nvs_handle_t nvs_handle;
    char ssid[33] = {0};
    char pass[64] = {0};
    size_t ssid_len = sizeof(ssid);
    size_t pass_len = sizeof(pass);
    bool has_creds = false;

    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs_handle);
    if (err == ESP_OK) {
        if (nvs_get_str(nvs_handle, NVS_KEY_SSID, ssid, &ssid_len) == ESP_OK &&
            nvs_get_str(nvs_handle, NVS_KEY_PASS, pass, &pass_len) == ESP_OK) {
            has_creds = true;
        }
        nvs_close(nvs_handle);
    }

    // 3. Start Mode
    if (has_creds && strlen(ssid) > 0) {
        wifi_init_station(ssid, pass);
        return false;
    } else {
        wifi_init_softap();
        return true;
    }
}

void wifi_manager_erase_config(void) {
    ESP_LOGW(TAG, "Erasing WiFi Config from NVS...");
    nvs_handle_t nvs_handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs_handle) == ESP_OK) {
        nvs_erase_all(nvs_handle);
        nvs_commit(nvs_handle);
        nvs_close(nvs_handle);
    }
}
