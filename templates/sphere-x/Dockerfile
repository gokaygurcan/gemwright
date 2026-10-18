FROM debian:trixie-slim AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends g++ gcc cmake ninja-build git libmariadb-dev ca-certificates && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /source
COPY server/ ./
RUN cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release && cmake --build build -j2 && \
    find build -type f -name 'SphereSvr*' -executable -exec cp {} /source/spheresvr \; && ./spheresvr --help

FROM debian:trixie-slim
ENV GEMWRIGHT_EMULATOR=sphere-x
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get install -y --no-install-recommends libmariadb3 libstdc++6 tzdata ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /source/spheresvr /opt/sphere/spheresvr
COPY shard/ /opt/shard/
COPY seed/ /opt/seed/
COPY start.sh run-server.sh /opt/gemwright/
RUN chmod +x /opt/gemwright/*.sh
WORKDIR /app
EXPOSE 2593
ENTRYPOINT ["/opt/gemwright/start.sh"]
