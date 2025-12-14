#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include "esp_err.h"
#include "esp_http_server.h"

// Initialize Wi-Fi (Checks NVS, starts AP or STA)
bool wifi_manager_init_wifi(void);

// Register provisioning URI handlers to the server
void wifi_manager_register_uri(httpd_handle_t server);

// Helper to erase NVS credentials (can be called by button handler)
void wifi_manager_erase_config(void);

#endif // WIFI_MANAGER_H
