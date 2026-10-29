FROM caddy:2.11.7-alpine

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/Caddyfile.qa /etc/caddy/Caddyfile.qa

ENTRYPOINT ["/bin/sh", "-c"]
CMD ["config=${CADDYFILE_PATH:-./Caddyfile}; case \"$config\" in ./Caddyfile|./Caddyfile.qa) ;; *) echo 'CADDYFILE_PATH must be ./Caddyfile or ./Caddyfile.qa' >&2; exit 1 ;; esac; exec caddy run --config \"/etc/caddy/${config#./}\" --adapter caddyfile"]
