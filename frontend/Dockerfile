# Frontend image: static files served by unprivileged nginx (UID 101, port 8080).
# About 50 MB; under 10 MiB of memory at idle.
FROM nginxinc/nginx-unprivileged:stable-alpine

# Take the latest Alpine security fixes (the image scan fails on fixable critical CVEs).
USER root
RUN apk upgrade --no-cache

ARG VERSION=dev
LABEL org.opencontainers.image.title="pet-portal/frontend" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.source="https://github.com/<team>/pet-portal-app"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html config.js /usr/share/nginx/html/
COPY css /usr/share/nginx/html/css
COPY js /usr/share/nginx/html/js
COPY assets /usr/share/nginx/html/assets

USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1