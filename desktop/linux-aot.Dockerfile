FROM rockylinux:9@sha256:d7be1c094cc5845ee815d4632fe377514ee6ebcf8efaed6892889657e5ddaaa6 AS build

RUN dnf --enablerepo=crb install -y clang cmake gcc-c++ git gzip libicu ninja-build openssl-libs krb5-libs tar zlib-devel \
    && dnf clean all
RUN curl -qfL --proto '=https' --proto-redir '=https' \
      https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-linux-x64.tar.gz -o /tmp/dotnet.tar.gz \
    && printf '%s  %s\n' 51c8b999af9e8dd9998c9edc5944e19a90788862068acd38694e098889054ce8c23d4f0c5cccfa16bf187d044562359e5ee69a9f8ad0bbe913ba90311fbce25b /tmp/dotnet.tar.gz | sha512sum -c - \
    && mkdir /opt/dotnet \
    && tar -xzf /tmp/dotnet.tar.gz -C /opt/dotnet \
    && rm /tmp/dotnet.tar.gz
RUN curl -qfL --proto '=https' --proto-redir '=https' \
      https://raw.githubusercontent.com/obselate/goo/f8a1189a8c03919b69599e0ca638297982a2e4ce/.github/scripts/install-shader-toolchain-linux-x64.sh -o /tmp/install-shaders.sh \
    && printf '%s  %s\n' 8d0a7c8c22ace52ca5b85ece71531ace13060af245fb8fcaeed01a65bc3e5947 /tmp/install-shaders.sh | sha256sum -c - \
    && bash /tmp/install-shaders.sh /opt/shaders
ENV PATH=/opt/dotnet:/opt/shaders/slang-2026.16/bin:/opt/shaders/vulkan-sdk-1.4.357.0/bin:$PATH \
    SLANG_SDK=/opt/shaders/slang-2026.16 \
    VULKAN_SDK=/opt/shaders/vulkan-sdk-1.4.357.0 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1
COPY source.tar /tmp/source.tar
RUN mkdir /src && tar -xf /tmp/source.tar -C /src && rm /tmp/source.tar
WORKDIR /src
RUN dotnet publish desktop/TokateDesktop.gsproj -c Release -r linux-x64 --self-contained true \
      -p:PublishAot=true -p:NuGetLockFilePath=/tmp/packages.lock.json -o /out -warnaserror --nologo \
    && { rpm -q glibc clang; dotnet --version; } > /out/build-environment.txt

FROM scratch
COPY --from=build /out /out
