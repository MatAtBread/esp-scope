idf_component_register(SRCS "main.c" "wifi_manager.c"
                    INCLUDE_DIRS "."
                    EMBED_TXTFILES "index.html" "index.js"
                    REQUIRES esp_http_server esp_adc nvs_flash esp_wifi esp_driver_gpio esp_driver_ledc esp_netif freertos esp_event esp_timer)

