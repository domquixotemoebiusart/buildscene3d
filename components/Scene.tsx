'use client';

import { useEffect, useRef, useState } from 'react';

// 🎨 Shaders de alta qualidade para PLY/SPLAT - Opacity previsível + cor fiel + densidade preservada
const plyVertexShader = `
varying vec3 vColor;
uniform float uPointSize;

void main() {
  vColor = color.rgb;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);

  // Tamanho controlável via uniform
  gl_PointSize = uPointSize;
}
`;

const plyFragmentShader = `
precision highp float;

uniform float uOpacity;
uniform float uBrightness;
varying vec3 vColor;

// Conversão sRGB → Linear (padrão real de engine)
vec3 srgbToLinear(vec3 c) {
  return mix(
    c / 12.92,
    pow((c + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, c)
  );
}

void main() {
  vec3 color = srgbToLinear(vColor);
  
  // Aplica brilho (brightness multiplier)
  color *= uBrightness;

  // Opacity global previsível
  float alpha = uOpacity;

  // ⚠️ Para PLY RGB puro, NÃO descartamos fragmentos (preserva densidade)
  gl_FragColor = vec4(color, alpha);
}
`;

interface SceneProps {
  modelPaths: string[];
  texturePath?: string | null;
}

interface DebugInfo {
  camera: { x: number; y: number; z: number };
  cameraRotation: { x: number; y: number; z: number };
  lookAt: { x: number; y: number; z: number };
  viewport: {
    width: number;
    height: number;
    aspect: number;
    fov: number;
    near: number;
    far: number;
    frustumWidth: number;
    frustumHeight: number;
    distanceToOrigin: number;
    visibleArea: number;
  };
  objects: Array<{ 
    name: string; 
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
  }>;
}

export default function Scene({ modelPaths, texturePath }: SceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [frameCount, setFrameCount] = useState(0);
  const [useARCamera, setUseARCamera] = useState(false);
  const [isVideoReady, setIsVideoReady] = useState(false);
  const [bgTextureEnabled, setBgTextureEnabled] = useState(false); // Controla se a textura de fundo está ativa
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sceneRef = useRef<any>(null); // Ref para a cena Three.js
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bgTextureRef = useRef<any>(null); // Ref para a textura de fundo carregada
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sceneObjectsRef = useRef<Array<{ name: string; object: any; targetPosition: { x: number; y: number; z: number }; opacity: number; visible: boolean }>>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cameraARRef = useRef<any>(null);
  const deviceOrientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const debugInfoRef = useRef<DebugInfo>({
    camera: { x: 0, y: 0, z: 0 },
    cameraRotation: { x: 0, y: 0, z: 0 },
    lookAt: { x: 0, y: 0, z: 0 },
    viewport: {
      width: 0,
      height: 0,
      aspect: 0,
      fov: 0,
      near: 0,
      far: 0,
      frustumWidth: 0,
      frustumHeight: 0,
      distanceToOrigin: 0,
      visibleArea: 0,
    },
    objects: [],
  });
  const [debugInfo, setDebugInfo] = useState<DebugInfo>(debugInfoRef.current);
  const [showCameraPrompt, setShowCameraPrompt] = useState(true);
  const [showDebugOverlay, setShowDebugOverlay] = useState(true);
  const [sceneEnabled, setSceneEnabled] = useState(false); // Controla se a cena está ativa (inicia desabilitada)
  const deviceMotionRef = useRef({ x: 0, y: 0, z: 0 });
  const initialOrientationRef = useRef({ alpha: 0, beta: 0, gamma: 0 });
  const isInitialOrientationSet = useRef(false);
  const sceneInitialized = useRef(false); // Flag para prevenir múltiplas inicializações
  const sceneHasStartedOnce = useRef(false); // Flag para controlar se a cena já foi iniciada uma vez
  const cleanupFunctionsRef = useRef<(() => void)[]>([]); // Ref para funções de cleanup
  const [savedCameras, setSavedCameras] = useState<Array<{
    id: number;
    name: string;
    position: { x: number; y: number; z: number };
    rotation: { x: number; y: number; z: number };
    lookAt: { x: number; y: number; z: number };
  }>>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeCameraRef = useRef<any>(null); // Ref para a câmera ativa
  const [isAnimating, setIsAnimating] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  const animationProgressRef = useRef(0);
  const animationDurationRef = useRef(5000); // Duração total da animação em ms
  const [animatingObjects, setAnimatingObjects] = useState<Set<string>>(new Set());
  const objectAnimationFramesRef = useRef<Map<string, number>>(new Map());

  // Função para atualizar a posição de um objeto com smooth transition
  const updateObjectPosition = (objectName: string, axis: 'x' | 'y' | 'z', value: number) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      objData.targetPosition[axis] = value;
      console.log(`🎯 Target posição: ${objectName} - ${axis.toUpperCase()}: ${value}`);
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função helper para aplicar opacity baseada no tipo de arquivo
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyObjectOpacity = (object: any, objectName: string, opacity: number) => {
    const fileExt = objectName.toLowerCase().split('.').pop();
    const isPlyOrSplat = fileExt === 'ply' || fileExt === 'splat';
    
    if (isPlyOrSplat) {
      // 💎 PLY/SPLAT: Aplica no uniform uOpacity do ShaderMaterial
      if (object.material && object.material.uniforms && object.material.uniforms.uOpacity) {
        object.material.uniforms.uOpacity.value = opacity;
      }
    } else {
      // 📦 GLB: Aplica no material padrão (lógica original)
      if (object.material) {
        if (Array.isArray(object.material)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          object.material.forEach((mat: any) => {
            mat.opacity = opacity;
            mat.transparent = opacity < 1;
          });
        } else {
          object.material.opacity = opacity;
          object.material.transparent = opacity < 1;
        }
      }
      // Para GLB com children
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      object.traverse((child: any) => {
        if (child.material) {
          if (Array.isArray(child.material)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.material.forEach((mat: any) => {
              mat.opacity = opacity;
              mat.transparent = opacity < 1;
            });
          } else {
            child.material.opacity = opacity;
            child.material.transparent = opacity < 1;
          }
        }
      });
    }
  };

  // Função para atualizar a opacidade de um objeto
  // 🎛 Roteamento correto: .ply/.splat → uOpacity uniform | .glb → material.opacity padrão
  const updateObjectOpacity = (objectName: string, opacity: number) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      objData.opacity = Math.max(0, Math.min(1, opacity)); // Clamp entre 0 e 1
      
      // Detecta tipo de arquivo
      const fileExt = objectName.toLowerCase().split('.').pop();
      const isPlyOrSplat = fileExt === 'ply' || fileExt === 'splat';
      
      if (isPlyOrSplat) {
        // 💎 PLY/SPLAT: Controla uOpacity uniform no ShaderMaterial
        const material = objData.object.material;
        if (material && material.uniforms && material.uniforms.uOpacity) {
          material.uniforms.uOpacity.value = objData.opacity;
          console.log(`🎨 PLY/SPLAT Opacity: ${objectName} = ${objData.opacity} (uniform)`);
        }
      } else {
        // 📦 GLB: Mantém lógica atual (material padrão)
        console.log(`🎨 GLB Opacity: ${objectName} = ${objData.opacity}`);
      }
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função para alternar visibilidade de um objeto
  const toggleObjectVisibility = (objectName: string, visible: boolean) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      objData.visible = visible;
      console.log(`👁️ Visibilidade: ${objectName} = ${visible}`);
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função para atualizar o brilho de gaussian splats (.ply/.splat)
  const updateObjectBrightness = (objectName: string, brightness: number) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      const fileExt = objectName.toLowerCase().split('.').pop();
      const isPlyOrSplat = fileExt === 'ply' || fileExt === 'splat';
      
      if (isPlyOrSplat) {
        const material = objData.object.material;
        if (material && material.uniforms && material.uniforms.uBrightness) {
          material.uniforms.uBrightness.value = Math.max(0, brightness); // Clamp mínimo 0
          console.log(`💡 Brilho: ${objectName} = ${brightness.toFixed(2)}x`);
        }
      } else {
        console.warn(`⚠️ Brilho só funciona com .ply/.splat: ${objectName}`);
      }
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função para atualizar o tamanho dos pontos de gaussian splats (.ply/.splat)
  const updateObjectPointSize = (objectName: string, pointSize: number) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      const fileExt = objectName.toLowerCase().split('.').pop();
      const isPlyOrSplat = fileExt === 'ply' || fileExt === 'splat';
      
      if (isPlyOrSplat) {
        const material = objData.object.material;
        if (material && material.uniforms && material.uniforms.uPointSize) {
          material.uniforms.uPointSize.value = Math.max(0.1, pointSize); // Clamp mínimo 0.1
          console.log(`📏 Tamanho de Ponto: ${objectName} = ${pointSize.toFixed(1)}px`);
        }
      } else {
        console.warn(`⚠️ Tamanho de ponto só funciona com .ply/.splat: ${objectName}`);
      }
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função para toggle background texture
  const toggleBackgroundTexture = (enabled: boolean) => {
    if (!sceneRef.current) {
      console.error('❌ Cena não disponível');
      return;
    }

    if (enabled && bgTextureRef.current) {
      sceneRef.current.background = bgTextureRef.current;
      sceneRef.current.environment = bgTextureRef.current;
      setBgTextureEnabled(true);
      console.log('🖼️ Background texture ativada');
    } else {
      sceneRef.current.background = null;
      sceneRef.current.environment = null;
      setBgTextureEnabled(false);
      console.log('🔲 Background texture desativada (transparente)');
    }
  };

  // Função para animar opacity de 0 até o valor configurado
  const playOpacityAnimation = (objectName: string) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (!objData) {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
      return;
    }

    // Cancela animação anterior deste objeto se existir
    const existingAnimFrame = objectAnimationFramesRef.current.get(objectName);
    if (existingAnimFrame) {
      cancelAnimationFrame(existingAnimFrame);
    }

    // Marca objeto como animando
    setAnimatingObjects(prev => new Set(prev).add(objectName));

    const targetOpacity = objData.opacity; // Valor configurado no slider
    const duration = 1500; // 1.5 segundos de animação
    const startTime = Date.now();

    console.log(`▶️ Iniciando animação de opacity: ${objectName} (0 → ${targetOpacity.toFixed(2)})`);

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      
      // Interpolação linear de 0 até targetOpacity
      const currentOpacity = progress * targetOpacity;

      // Aplica opacity atual
      const fileExt = objectName.toLowerCase().split('.').pop();
      const isPlyOrSplat = fileExt === 'ply' || fileExt === 'splat';
      
      if (isPlyOrSplat) {
        // PLY/SPLAT: Aplica no uniform
        const material = objData.object.material;
        if (material && material.uniforms && material.uniforms.uOpacity) {
          material.uniforms.uOpacity.value = currentOpacity;
        }
      } else {
        // GLB: Aplica no material padrão
        applyObjectOpacity(objData.object, objectName, currentOpacity);
      }

      if (progress < 1) {
        // Continua animação
        const frameId = requestAnimationFrame(animate);
        objectAnimationFramesRef.current.set(objectName, frameId);
      } else {
        // Animação completa
        console.log(`✅ Animação completa: ${objectName}`);
        objectAnimationFramesRef.current.delete(objectName);
        setAnimatingObjects(prev => {
          const newSet = new Set(prev);
          newSet.delete(objectName);
          return newSet;
        });
      }
    };

    animate();
  };

  // Função para atualizar a rotação de um objeto
  const updateObjectRotation = (objectName: string, axis: 'x' | 'y' | 'z', degrees: number) => {
    const objData = sceneObjectsRef.current.find(obj => obj.name === objectName);
    if (objData) {
      const radians = degrees * (Math.PI / 180);
      objData.object.rotation[axis] = radians;
      console.log(`🔄 Rotação: ${objectName} - ${axis.toUpperCase()}: ${degrees}°`);
    } else {
      console.error(`❌ Objeto não encontrado: ${objectName}`);
    }
  };

  // Função para salvar posição da câmera atual
  const saveCamera = () => {
    if (!activeCameraRef.current) {
      console.error('❌ Nenhuma câmera ativa disponível');
      return;
    }

    if (savedCameras.length >= 4) {
      console.warn('⚠️ Limite de 4 câmeras atingido');
      return;
    }

    const camera = activeCameraRef.current;
    
    const newCamera = {
      id: Date.now(),
      name: `Camera ${savedCameras.length + 1}`,
      position: {
        x: parseFloat(camera.position.x.toFixed(2)),
        y: parseFloat(camera.position.y.toFixed(2)),
        z: parseFloat(camera.position.z.toFixed(2)),
      },
      rotation: {
        x: parseFloat((camera.rotation.x * 180 / Math.PI).toFixed(1)),
        y: parseFloat((camera.rotation.y * 180 / Math.PI).toFixed(1)),
        z: parseFloat((camera.rotation.z * 180 / Math.PI).toFixed(1)),
      },
      lookAt: {
        x: debugInfo.lookAt.x,
        y: debugInfo.lookAt.y,
        z: debugInfo.lookAt.z,
      },
    };

    setSavedCameras([...savedCameras, newCamera]);
    console.log('📷 Câmera salva:', newCamera);
  };

  // Função para aplicar posição de câmera salva
  const applySavedCamera = (cameraData: typeof savedCameras[0]) => {
    if (!activeCameraRef.current) {
      console.error('❌ Nenhuma câmera ativa disponível');
      return;
    }

    const camera = activeCameraRef.current;
    camera.position.set(cameraData.position.x, cameraData.position.y, cameraData.position.z);
    camera.rotation.set(
      cameraData.rotation.x * (Math.PI / 180),
      cameraData.rotation.y * (Math.PI / 180),
      cameraData.rotation.z * (Math.PI / 180)
    );
    console.log('📷 Câmera aplicada:', cameraData.name);
  };

  // Função para deletar câmera salva
  const deleteSavedCamera = (id: number) => {
    setSavedCameras(savedCameras.filter(cam => cam.id !== id));
    console.log('🗑️ Câmera deletada:', id);
  };

  // Função para criar e iniciar animação interpolada entre câmeras
  const createCameraAnimation = () => {
    if (savedCameras.length < 2) {
      console.warn('⚠️ Precisa de pelo menos 2 câmeras salvas para criar animação');
      return;
    }

    console.log('🎬 Criando animação com', savedCameras.length, 'câmeras');
    setIsAnimating(true);
    animationProgressRef.current = 0;
  };

  // Função para parar animação
  const stopCameraAnimation = () => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    setIsAnimating(false);
    animationProgressRef.current = 0;
    console.log('⏸️ Animação parada');
  };

  // Função de interpolação linear (lerp)
  const lerp = (start: number, end: number, t: number) => {
    return start + (end - start) * t;
  };

  // Função de interpolação esférica para rotações (slerp simplificado)
  const lerpRotation = (start: number, end: number, t: number) => {
    // Normaliza ângulos para -180 a 180
    const normalize = (angle: number) => {
      while (angle > 180) angle -= 360;
      while (angle < -180) angle += 360;
      return angle;
    };
    
    const s = normalize(start);
    const e = normalize(end);
    let diff = e - s;
    
    // Pega o caminho mais curto
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    
    return normalize(s + diff * t);
  };

  // useEffect para animar câmera
  useEffect(() => {
    if (!isAnimating || savedCameras.length < 2 || !activeCameraRef.current) {
      return;
    }

    const startTime = Date.now();
    const duration = animationDurationRef.current;
    
    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      animationProgressRef.current = progress;

      // Calcula qual segmento da animação (entre quais câmeras)
      const totalSegments = savedCameras.length - 1;
      const segmentProgress = progress * totalSegments;
      const currentSegment = Math.min(Math.floor(segmentProgress), totalSegments - 1);
      const segmentT = segmentProgress - currentSegment;

      const startCam = savedCameras[currentSegment];
      const endCam = savedCameras[currentSegment + 1];

      // Interpola posição
      const camera = activeCameraRef.current;
      camera.position.x = lerp(startCam.position.x, endCam.position.x, segmentT);
      camera.position.y = lerp(startCam.position.y, endCam.position.y, segmentT);
      camera.position.z = lerp(startCam.position.z, endCam.position.z, segmentT);

      // Interpola rotação
      const rotX = lerpRotation(startCam.rotation.x, endCam.rotation.x, segmentT);
      const rotY = lerpRotation(startCam.rotation.y, endCam.rotation.y, segmentT);
      const rotZ = lerpRotation(startCam.rotation.z, endCam.rotation.z, segmentT);
      
      camera.rotation.x = rotX * (Math.PI / 180);
      camera.rotation.y = rotY * (Math.PI / 180);
      camera.rotation.z = rotZ * (Math.PI / 180);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        console.log('✅ Animação completa');
        setIsAnimating(false);
        animationProgressRef.current = 0;
      }
    };

    animate();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isAnimating, savedCameras]);

  // Inicializa webcam/câmera traseira
  const startARCamera = async () => {
    try {
      console.log('📹 Solicitando acesso à câmera...');
      console.log('🌐 Protocolo:', window.location.protocol);
      console.log('🔍 Navigator:', {
        mediaDevices: !!navigator.mediaDevices,
        getUserMedia: !!(navigator.mediaDevices?.getUserMedia),
        userAgent: navigator.userAgent,
      });
      
      // Verifica HTTPS (obrigatório para getUserMedia)
      if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        throw new Error('HTTPS_REQUIRED');
      }
      
      // Verifica se getUserMedia está disponível
      if (!navigator.mediaDevices) {
        // Fallback para API antiga (webkit)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nav = navigator as any;
        if (nav.getUserMedia || nav.webkitGetUserMedia || nav.mozGetUserMedia || nav.msGetUserMedia) {
          throw new Error('LEGACY_API');
        }
        throw new Error('NO_MEDIA_DEVICES');
      }
      
      if (!navigator.mediaDevices.getUserMedia) {
        throw new Error('NO_GET_USER_MEDIA');
      }

      // Solicita permissão explícita
      const constraints = {
        video: {
          facingMode: 'environment', // Tenta câmera traseira primeiro
          width: { ideal: 1920 },
          height: { ideal: 1440 },
        },
        audio: false,
      };

      console.log('📱 Solicitando permissão com constraints:', constraints);
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      console.log('✅ Stream obtido:', stream);

      if (!videoRef.current) {
        console.error('❌ videoRef.current não está disponível');
        throw new Error('Elemento de vídeo não encontrado');
      }

      videoRef.current.srcObject = stream;
      
      // Adiciona listener para quando o metadata carregar
      videoRef.current.onloadedmetadata = async () => {
        console.log('📹 Metadata carregado');
        try {
          await videoRef.current?.play();
          setIsVideoReady(true);
          console.log('✅ Câmera iniciada com sucesso:', {
            width: videoRef.current?.videoWidth,
            height: videoRef.current?.videoHeight,
            aspect: (videoRef.current?.videoWidth || 1) / (videoRef.current?.videoHeight || 1),
          });
        } catch (playError) {
          console.error('❌ Erro ao reproduzir vídeo:', playError);
        }
      };

      videoRef.current.onerror = (error) => {
        console.error('❌ Erro no elemento de vídeo:', error);
      };

      // Solicita permissão para DeviceOrientation (iOS 13+)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (DeviceOrientationEvent as any).requestPermission === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const permission = await (DeviceOrientationEvent as any).requestPermission();
          if (permission === 'granted') {
            window.addEventListener('deviceorientation', handleDeviceOrientation);
            console.log('✅ Permissão DeviceOrientation concedida');
          } else {
            console.warn('⚠️ Permissão DeviceOrientation negada');
          }
        } catch (orientationError) {
          console.warn('⚠️ Erro ao solicitar DeviceOrientation:', orientationError);
        }
      } else {
        window.addEventListener('deviceorientation', handleDeviceOrientation);
        console.log('✅ DeviceOrientation listener adicionado');
      }

      // Adiciona listener para DeviceMotion (acelerômetro)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (typeof (DeviceMotionEvent as any).requestPermission === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const permission = await (DeviceMotionEvent as any).requestPermission();
          if (permission === 'granted') {
            window.addEventListener('devicemotion', handleDeviceMotion);
            console.log('✅ Permissão DeviceMotion concedida');
          }
        } catch (motionError) {
          console.warn('⚠️ Erro ao solicitar DeviceMotion:', motionError);
        }
      } else {
        window.addEventListener('devicemotion', handleDeviceMotion);
        console.log('✅ DeviceMotion listener adicionado');
      }

      setUseARCamera(true);
      isInitialOrientationSet.current = false; // Reset para capturar nova orientação inicial
      console.log('✅ AR Camera ativada');
      
    } catch (error) {
      console.error('❌ Erro detalhado ao acessar câmera:', error);
      
      let errorMessage = 'Não foi possível acessar a câmera.\n\n';
      
      if (error instanceof Error) {
        // Erros customizados
        if (error.message === 'HTTPS_REQUIRED') {
          errorMessage = '🔒 HTTPS Obrigatório\n\n';
          errorMessage += 'A câmera só funciona em:\n';
          errorMessage += '• Sites HTTPS (https://...)\n';
          errorMessage += '• localhost\n\n';
          errorMessage += `Você está acessando via: ${window.location.protocol}\n\n`;
          errorMessage += '💡 Para testar no celular:\n';
          errorMessage += '1. Use um túnel HTTPS (ngrok, cloudflare tunnel)\n';
          errorMessage += '2. Ou acesse via cabo USB com port forwarding';
        } else if (error.message === 'NO_MEDIA_DEVICES') {
          errorMessage = '❌ Navegador Não Suportado\n\n';
          errorMessage += 'Seu navegador não suporta MediaDevices API.\n\n';
          errorMessage += '✅ Navegadores suportados:\n';
          errorMessage += '• Chrome/Edge 53+\n';
          errorMessage += '• Firefox 36+\n';
          errorMessage += '• Safari 11+\n\n';
          errorMessage += `Seu navegador: ${navigator.userAgent}`;
        } else if (error.message === 'NO_GET_USER_MEDIA') {
          errorMessage = '❌ getUserMedia Não Disponível\n\n';
          errorMessage += 'Seu navegador não suporta getUserMedia.\n\n';
          errorMessage += '💡 Tente atualizar seu navegador para a versão mais recente.';
        } else if (error.message === 'LEGACY_API') {
          errorMessage = '⚠️ API Antiga Detectada\n\n';
          errorMessage += 'Seu navegador usa uma versão antiga da API de câmera.\n\n';
          errorMessage += '💡 Por favor, atualize seu navegador.';
        } else if (error.name === 'NotAllowedError') {
          errorMessage = '🚫 Permissão Negada\n\n';
          errorMessage += 'Você bloqueou o acesso à câmera.\n\n';
          errorMessage += '✅ Para permitir:\n';
          errorMessage += '1. Toque no ícone 🔒 ou ⓘ na barra de endereços\n';
          errorMessage += '2. Ative "Câmera"\n';
          errorMessage += '3. Recarregue a página';
        } else if (error.name === 'NotFoundError') {
          errorMessage = '❌ Câmera Não Encontrada\n\n';
          errorMessage += 'Nenhuma câmera foi detectada no seu dispositivo.';
        } else if (error.name === 'NotReadableError') {
          errorMessage = '⚠️ Câmera em Uso\n\n';
          errorMessage += 'A câmera está sendo usada por outro aplicativo.\n\n';
          errorMessage += '💡 Feche outros apps que possam estar usando a câmera.';
        } else if (error.name === 'OverconstrainedError') {
          errorMessage += '❌ Configurações de câmera não suportadas. Tentando novamente com configurações básicas...';
          
          // Tenta novamente com configurações mais simples
          try {
            const simpleStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
            
            if (videoRef.current) {
              videoRef.current.srcObject = simpleStream;
              await videoRef.current.play();
              setIsVideoReady(true);
              setUseARCamera(true);
              console.log('✅ Câmera iniciada com configurações básicas');
              return;
            }
          } catch (retryError) {
            console.error('❌ Falha na segunda tentativa:', retryError);
          }
        } else {
          errorMessage += `Erro: ${error.message}`;
        }
      }
      
      alert(errorMessage);
      setShowCameraPrompt(false);
    }
  };

  const stopARCamera = () => {
    if (videoRef.current?.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    window.removeEventListener('deviceorientation', handleDeviceOrientation);
    window.removeEventListener('devicemotion', handleDeviceMotion);
    setUseARCamera(false);
    setIsVideoReady(false);
    isInitialOrientationSet.current = false;
  };

  const handleDeviceOrientation = (event: DeviceOrientationEvent) => {
    // Salva orientação inicial como referência
    if (!isInitialOrientationSet.current && useARCamera) {
      initialOrientationRef.current = {
        alpha: event.alpha || 0,
        beta: event.beta || 0,
        gamma: event.gamma || 0,
      };
      isInitialOrientationSet.current = true;
      console.log('📍 Orientação inicial definida:', initialOrientationRef.current);
    }

    deviceOrientationRef.current = {
      alpha: event.alpha || 0,  // yaw (rotação Z)
      beta: event.beta || 0,    // pitch (rotação X)
      gamma: event.gamma || 0,  // roll (rotação Y)
    };
  };

  const handleDeviceMotion = (event: DeviceMotionEvent) => {
    if (event.accelerationIncludingGravity && useARCamera) {
      // Aceleração com gravidade (m/s²)
      const acc = event.accelerationIncludingGravity;
      deviceMotionRef.current = {
        x: acc.x || 0,
        y: acc.y || 0,
        z: acc.z || 0,
      };
    }
  };

  // 🗑️ Função para limpar múltiplas cenas e objetos duplicados
  const deleteMultipleScenesAndDuplicates = () => {
    console.log('🧹 Iniciando limpeza de múltiplas cenas e duplicados...');
    
    if (!containerRef.current) {
      console.log('⚠️ Container não disponível para limpeza');
      return;
    }

    // 1. Remove todos os canvas existentes (múltiplas cenas)
    const canvasElements = containerRef.current.querySelectorAll('canvas');
    if (canvasElements.length > 0) {
      console.log(`🗑️ Encontrados ${canvasElements.length} canvas element(s)`);
      canvasElements.forEach((canvas, index) => {
        try {
          // Tenta forçar perda de contexto WebGL
          const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
          if (gl) {
            const loseContext = gl.getExtension('WEBGL_lose_context');
            if (loseContext) {
              loseContext.loseContext();
              console.log(`  ✅ Contexto WebGL perdido do canvas ${index}`);
            }
          }
          
          // Remove do DOM
          if (canvas.parentNode) {
            canvas.parentNode.removeChild(canvas);
            console.log(`  ✅ Canvas ${index} removido do DOM`);
          }
        } catch (error) {
          console.error(`  ❌ Erro ao remover canvas ${index}:`, error);
        }
      });
    }

    // 2. Limpa objetos duplicados no sceneObjectsRef
    const uniqueObjects = new Map();
    const duplicates: string[] = [];
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sceneObjectsRef.current.forEach((item) => {
      if (uniqueObjects.has(item.name)) {
        duplicates.push(item.name);
        // Limpa o objeto duplicado
        try {
          if (item.object.geometry) item.object.geometry.dispose();
          if (item.object.material) {
            if (Array.isArray(item.object.material)) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              item.object.material.forEach((mat: any) => mat.dispose());
            } else {
              item.object.material.dispose();
            }
          }
          console.log(`  🗑️ Objeto duplicado limpo: ${item.name}`);
        } catch (error) {
          console.error(`  ❌ Erro ao limpar duplicado ${item.name}:`, error);
        }
      } else {
        uniqueObjects.set(item.name, item);
      }
    });

    if (duplicates.length > 0) {
      console.log(`🗑️ Duplicados encontrados e removidos: ${duplicates.join(', ')}`);
      // Atualiza o ref apenas com objetos únicos
      sceneObjectsRef.current = Array.from(uniqueObjects.values());
      console.log(`✅ sceneObjectsRef atualizado. Total de objetos únicos: ${sceneObjectsRef.current.length}`);
    } else {
      console.log('✅ Nenhum objeto duplicado encontrado');
    }

    console.log('✅ Limpeza de múltiplas cenas e duplicados concluída');
  };

  useEffect(() => {
    // Só inicia a cena se sceneEnabled for true, ainda não foi inicializada E não iniciou antes
    if (!containerRef.current || modelPaths.length === 0 || !sceneEnabled || sceneHasStartedOnce.current) return;

    console.log('🔄 useEffect executado. ModelPaths:', modelPaths);
    console.log('🚦 sceneInitialized.current:', sceneInitialized.current);

    // 🧹 LIMPA múltiplas cenas e duplicados ANTES de verificar inicialização
    deleteMultipleScenesAndDuplicates();

    // Previne múltiplas inicializações simultâneas
    if (sceneInitialized.current) {
      console.warn('⚠️ AVISO: Tentativa de inicializar cena duplicada bloqueada!');
      return;
    }
    
    sceneInitialized.current = true;
    sceneHasStartedOnce.current = true; // Marca que a cena já foi iniciada uma vez
    console.log('✅ Flag sceneInitialized definida como true');
    console.log('✅ Flag sceneHasStartedOnce definida como true - cena não reiniciará');
    
    // Limpa array anterior de cleanup functions
    cleanupFunctionsRef.current = [];

    const init = async () => {
      if (!containerRef.current) return;

      // 🧹 LIMPEZA PROFUNDA: Remove qualquer resíduo de objetos no container
      console.log('🧹 Limpeza profunda do container...');
      
      // Limpa objetos anteriores para evitar duplicação
      sceneObjectsRef.current = [];
      console.log('  ✅ SceneObjectsRef limpo');
      
      // Remove qualquer canvas órfão ainda presente
      const orphanCanvases = containerRef.current.querySelectorAll('canvas');
      if (orphanCanvases.length > 0) {
        console.log(`  🗑️ Removendo ${orphanCanvases.length} canvas órfão(s)...`);
        orphanCanvases.forEach(canvas => {
          canvas.remove();
        });
      }

      console.log('🔍 Estado inicial - useEffect disparado para:', modelPaths);
      console.log('🚀 Iniciando carregamento de modelos:', modelPaths);

      // Check for unsupported .spz files first
      const spzFiles = modelPaths.filter(path => {
        const ext = path.split('.').pop()?.toLowerCase();
        return ext === 'spz';
      });

      if (spzFiles.length > 0) {
        console.error('❌ ERRO: Arquivos .spz não são suportados pela biblioteca gaussian-splats-3d');
        console.error('📝 Arquivos .spz encontrados:', spzFiles);
        console.info('💡 SOLUÇÃO: Converta seus arquivos .spz para .splat usando:');
        console.info('   → SuperSplat: https://playcanvas.com/supersplat/editor');
        console.info('   → Ou renomeie para .ply se for um Point Cloud');
      }

      // Filtra arquivos por tipo
      const plyFiles = modelPaths.filter(path => {
        const ext = path.split('.').pop()?.toLowerCase();
        return ext === 'ply';
      });

      const glbFiles = modelPaths.filter(path => {
        const ext = path.split('.').pop()?.toLowerCase();
        return ext === 'glb';
      });

      // Inicializa a cena se houver qualquer arquivo suportado
      if (plyFiles.length > 0 || glbFiles.length > 0) {
        console.log('📦 Carregando modelos:', { ply: plyFiles.length, glb: glbFiles.length });

        const THREE = await import('three');
        const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
        const { PLYLoader } = await import('three/examples/jsm/loaders/PLYLoader.js');
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');

        const scene = new THREE.Scene();
        // Background transparente quando AR está ativo, preto quando não está
        scene.background = null; // Sempre transparente para ver o vídeo
        sceneRef.current = scene; // Armazena referência da cena
        console.log('🎬 Nova cena criada | Objetos na cena:', scene.children.length);

        // 🖼️ Carrega textura de fundo se fornecida
        if (texturePath) {
          const fileExt = texturePath.toLowerCase().split('.').pop();
          
          if (fileExt === 'hdr') {
            // HDR: usa RGBELoader para equirectangular HDR
            const { RGBELoader } = await import('three/examples/jsm/loaders/RGBELoader.js');
            const rgbeLoader = new RGBELoader();
            rgbeLoader.load(
              texturePath,
              (texture) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                bgTextureRef.current = texture;
                console.log('✅ Textura HDR carregada:', texturePath);
              },
              undefined,
              (error) => {
                console.error('❌ Erro ao carregar HDR:', error);
              }
            );
          } else if (fileExt === 'png' || fileExt === 'jpg' || fileExt === 'jpeg') {
            // PNG/JPG: usa TextureLoader padrão
            const textureLoader = new THREE.TextureLoader();
            textureLoader.load(
              texturePath,
              (texture) => {
                texture.mapping = THREE.EquirectangularReflectionMapping;
                bgTextureRef.current = texture;
                console.log('✅ Textura carregada:', texturePath);
              },
              undefined,
              (error) => {
                console.error('❌ Erro ao carregar textura:', error);
              }
            );
          }
        }

        const camera = new THREE.PerspectiveCamera(
          75,
          containerRef.current.clientWidth / containerRef.current.clientHeight,
          0.1,
          1000
        );
        camera.position.set(0, 0, 8); // Posição frontal (x = 0 degrees rotation)
        camera.up.set(0, 1, 0); // Define Y como up (padrão)
        camera.lookAt(0, 0, 0); // Olha para o centro da cena
        activeCameraRef.current = camera; // Armazena câmera principal como ativa

        // 📱 Câmera 02 - AR Camera (câmera traseira do celular)
        // Valores realistas baseados em câmeras de smartphone
        const cameraAR = new THREE.PerspectiveCamera(
          53, // FOV realista cross-device (iPhone: 50-55°, Android: 55-60°)
          4 / 3, // Placeholder - será atualizado quando o video carregar
          0.01, // Near plane crítico para fake AR
          100   // Far plane - 1 unidade = 1 metro
        );
        cameraAR.position.set(0, 0, 0); // Câmera na origem
        cameraAR.rotation.order = 'YXZ'; // Ordem correta para DeviceOrientation
        cameraARRef.current = cameraAR;

        const renderer = new THREE.WebGLRenderer({ 
          antialias: true,
          alpha: true, // CRÍTICO: transparência para ver o vídeo
        });
        renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 0); // CRÍTICO: alpha 0 = transparente
        containerRef.current.appendChild(renderer.domElement);
        
        // Garante que o canvas fique sobre o vídeo mas com fundo transparente
        renderer.domElement.style.position = 'absolute';
        renderer.domElement.style.top = '0';
        renderer.domElement.style.left = '0';
        renderer.domElement.style.zIndex = '10'; // Acima do vídeo (z-index: 1)
        renderer.domElement.style.pointerEvents = 'auto'; // Permite interação com OrbitControls

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        scene.add(ambientLight);

        const pointLight = new THREE.PointLight(0xffffff, 1);
        pointLight.position.set(10, 10, 10);
        scene.add(pointLight);
        console.log('💡 Luzes adicionadas | Total objetos na cena:', scene.children.length);

        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.screenSpacePanning = false; // Mantém Z como up durante pan
        controls.maxPolarAngle = Math.PI; // Permite rotação completa

        const loader = new PLYLoader();
        const gltfLoader = new GLTFLoader();

        // Array para rastrear objetos (usando ref global)
        sceneObjectsRef.current = [];

        // 🔒 CARREGAMENTO SEQUENCIAL: Aguarda todos os modelos serem carregados antes de iniciar animação
        const loadingPromises: Promise<void>[] = [];
        
        // Carrega todos os arquivos GLB com Promises
        console.log('📋 Iniciando carregamento de GLBs. Total de arquivos:', glbFiles.length, glbFiles);
        
        glbFiles.forEach((glbFile, index) => {
          console.log(`🔄 Preparando carregamento GLB ${index}: ${glbFile}`);
          
          const glbPromise = new Promise<void>((resolve, reject) => {
            gltfLoader.load(
              glbFile,
              (gltf) => {
                const fileName = glbFile.split('/').pop() || `GLB ${index}`;
                
                // Verifica se já existe um objeto com esse nome na cena
                if (scene.getObjectByName(fileName)) {
                  console.warn('⚠️ DUPLICAÇÃO BLOQUEADA:', fileName, 'já existe na cena!');
                  resolve();
                  return;
                }
                
                const model = gltf.scene;
                model.position.set(0, 0, 0); // Nasce na origem
                model.name = fileName;
                console.log('➕ Adicionando GLB à cena:', fileName, '| Total objetos na cena antes:', scene.children.length);
                scene.add(model);
                console.log('✅ GLB adicionado:', fileName, '| Total objetos na cena depois:', scene.children.length);
                
                sceneObjectsRef.current.push({
                  name: fileName,
                  object: model,
                  targetPosition: { x: 0, y: 0, z: 0 },
                  opacity: 1,
                  visible: true
                });
                
                // Cleanup: modelo adicionado à cena, referências temporárias podem ser liberadas
                console.log(`🧹 GLB loader: recursos temporários liberados para ${fileName}`);
                resolve();
              },
              undefined,
              (error) => {
                console.error(`❌ Erro ao carregar GLB ${glbFile}:`, error);
                reject(error);
              }
            );
          });
          
          loadingPromises.push(glbPromise);
        });

        console.log('📋 Iniciando carregamento de PLYs. Total de arquivos:', plyFiles.length, plyFiles);
        
        // Carrega todos os PLYs com Promises para garantir ordem
        plyFiles.forEach((plyFile, index) => {
          console.log(`🔄 Preparando carregamento ${index}: ${plyFile}`);
          
          const plyPromise = new Promise<void>((resolve, reject) => {
            loader.load(
              plyFile,
              (geometry) => {
                geometry.computeVertexNormals();
                
                // 🔒 OBRIGATÓRIO: Normalização de cor para PLY/SPLAT (0-255 → 0-1)
                if (geometry.attributes.color) {
                  geometry.attributes.color.normalized = true;
                  console.log('✅ PLY: Color attribute normalized');
                }

                // 💎 ShaderMaterial de ALTA QUALIDADE para PLY/SPLAT
                const material = new THREE.ShaderMaterial({
                  transparent: true,
                  depthWrite: false,
                  depthTest: true,
                  vertexColors: true,
                  uniforms: {
                    uOpacity: { value: 1.0 },
                    uBrightness: { value: 1.0 }, // Brilho padrão = 1.0 (sem alteração)
                    uPointSize: { value: 2.0 } // Tamanho de ponto padrão = 2.0
                  },
                  vertexShader: plyVertexShader,
                  fragmentShader: plyFragmentShader
                });

                const points = new THREE.Points(geometry, material);
                const fileName = plyFile.split('/').pop() || `PLY ${index}`;
                
                // Verifica se já existe um objeto com esse nome na cena
                if (scene.getObjectByName(fileName)) {
                  console.warn('⚠️ DUPLICAÇÃO BLOQUEADA:', fileName, 'já existe na cena!');
                  resolve();
                  return;
                }
                
                points.name = fileName;
                
                geometry.computeBoundingBox();
                const boundingBox = geometry.boundingBox;
                if (boundingBox) {
                  const center = new THREE.Vector3();
                  boundingBox.getCenter(center);
                  
                  const size = new THREE.Vector3();
                  boundingBox.getSize(size);
                  const maxDim = Math.max(size.x, size.y, size.z);
                  const scale = 2 / maxDim;
                  
                  points.scale.setScalar(scale);
                  points.position.set(0, 0, 0); // Nasce na origem
                  points.rotation.set(Math.PI / 2, Math.PI, 0); // x = 90°, y = 180°
                }

                console.log('➕ Adicionando PLY à cena:', fileName, '| Total objetos na cena antes:', scene.children.length);
                scene.add(points);
                console.log('✅ PLY adicionado:', fileName, '| Total objetos na cena depois:', scene.children.length);
                sceneObjectsRef.current.push({ name: fileName, object: points, targetPosition: { x: 0, y: 0, z: 0 }, opacity: 1, visible: true });
                
                // Cleanup: geometria e material agora pertencem ao objeto Points na cena
                console.log(`🧹 PLY loader: recursos temporários liberados para ${fileName}`);
                resolve();
              },
              undefined,
              (error) => {
                console.error(`❌ Erro ao carregar PLY ${plyFile}:`, error);
                reject(error);
              }
            );
          });
          
          loadingPromises.push(plyPromise);
        });

        // 🎯 AGUARDA TODOS OS MODELOS SEREM CARREGADOS antes de iniciar a animação
        Promise.all(loadingPromises)
          .then(() => {
            console.log('✅ TODOS OS MODELOS CARREGADOS! Iniciando animação...');
            console.log('📊 Total de objetos carregados:', sceneObjectsRef.current.length);
            startAnimation();
          })
          .catch((error) => {
            console.error('❌ Erro ao carregar modelos:', error);
            // Mesmo com erro, tenta iniciar animação com o que foi carregado
            startAnimation();
          });

        let animationId: number;
        const startAnimation = () => {
          console.log('🎬 Iniciando loop de animação...');
          animate();
        };
        
        const animate = () => {
          animationId = requestAnimationFrame(animate);
          
          //  Fake 4DOF: Aplica movimento baseado em device orientation + motion
          if (useARCamera && isInitialOrientationSet.current) {
            sceneObjectsRef.current.forEach(({ name, object, targetPosition, opacity, visible }) => {
              // Calcula diferença de orientação desde a posição inicial
              const deltaAlpha = (deviceOrientationRef.current.alpha - initialOrientationRef.current.alpha) * (Math.PI / 180);
              const deltaBeta = (deviceOrientationRef.current.beta - initialOrientationRef.current.beta) * (Math.PI / 180);
              const deltaGamma = (deviceOrientationRef.current.gamma - initialOrientationRef.current.gamma) * (Math.PI / 180);
              
              // Rotaciona objetos baseado na orientação do celular (invertido para parecer fixo no espaço)
              object.rotation.z = -deltaAlpha * 0.5; // yaw
              object.rotation.x = -deltaBeta * 0.5; // pitch
              object.rotation.y = -deltaGamma * 0.5; // roll
              
              // Posição baseada em acelerômetro (parallax suave)
              // Acelera movimento quanto mais o celular se inclina
              const sensitivity = 0.05; // Ajuste para controlar sensibilidade
              const posX = targetPosition.x + (deltaGamma * sensitivity);
              const posY = targetPosition.y + (deltaBeta * sensitivity);
              
              // Lerp suave para a nova posição
              const lerpFactor = 0.1;
              object.position.x += (posX - object.position.x) * lerpFactor;
              object.position.y += (posY - object.position.y) * lerpFactor;
              object.position.z += (targetPosition.z - object.position.z) * lerpFactor;
              
              // Aplica opacity e visibility com roteamento correto
              object.visible = visible;
              applyObjectOpacity(object, name, opacity);
            });
          } else {
            // Modo normal: apenas lerp para targetPosition
            sceneObjectsRef.current.forEach(({ name, object, targetPosition, opacity, visible }) => {
              const lerpFactor = 0.1;
              object.position.x += (targetPosition.x - object.position.x) * lerpFactor;
              object.position.y += (targetPosition.y - object.position.y) * lerpFactor;
              object.position.z += (targetPosition.z - object.position.z) * lerpFactor;
              
              // Aplica opacity e visibility com roteamento correto
              object.visible = visible;
              applyObjectOpacity(object, name, opacity);
            });
          }

          // Seleciona câmera ativa
          const activeCamera = useARCamera ? cameraAR : camera;

          // Atualiza câmera AR com video aspect e device orientation
          if (useARCamera && isVideoReady && videoRef.current) {
            // ✅ REGRA DE OURO: aspect = video.videoWidth / video.videoHeight
            const videoAspect = videoRef.current.videoWidth / videoRef.current.videoHeight;
            if (cameraAR.aspect !== videoAspect) {
              cameraAR.aspect = videoAspect;
              cameraAR.updateProjectionMatrix();
              console.log('📐 Camera AR aspect atualizado:', videoAspect);
            }

            // Sincroniza com DeviceOrientation (fake 3DOF)
            const { alpha, beta, gamma } = deviceOrientationRef.current;
            // Converte device orientation para Euler angles
            cameraAR.rotation.y = THREE.MathUtils.degToRad(alpha); // yaw
            cameraAR.rotation.x = THREE.MathUtils.degToRad(beta - 90); // pitch (ajuste de 90° para landscape)
            cameraAR.rotation.z = THREE.MathUtils.degToRad(gamma); // roll
          }
          
          // Atualiza controles apenas para câmera principal
          if (!useARCamera) {
            controls.update();
          }
          
          // 🧹 Limpa buffers antes de renderizar para evitar cache visual
          renderer.clear(true, true, true);
          
          // Renderiza a cena
          renderer.render(scene, activeCamera);
          
          // Atualiza debug info constantemente
          const direction = new THREE.Vector3();
          camera.getWorldDirection(direction);
          const lookAtPoint = camera.position.clone().add(direction);
          
          // Atualiza informações de debug em tempo real
          const objectsInfo = sceneObjectsRef.current.map(({ name, object }) => ({
            name,
            position: {
              x: parseFloat(object.position.x.toFixed(2)),
              y: parseFloat(object.position.y.toFixed(2)),
              z: parseFloat(object.position.z.toFixed(2)),
            },
            rotation: {
              x: parseFloat((object.rotation.x * 180 / Math.PI).toFixed(1)),
              y: parseFloat((object.rotation.y * 180 / Math.PI).toFixed(1)),
              z: parseFloat((object.rotation.z * 180 / Math.PI).toFixed(1)),
            },
          }));

          // Calcula distância da câmera à origem
          const distanceToOrigin = parseFloat(camera.position.length().toFixed(2));
          
          // Calcula o tamanho do frustum no plano de distância atual
          const vFOV = camera.fov * Math.PI / 180; // converte para radianos
          const frustumHeight = 2 * Math.tan(vFOV / 2) * distanceToOrigin;
          const frustumWidth = frustumHeight * camera.aspect;
          
          // Calcula área visível aproximada
          const visibleArea = parseFloat((frustumWidth * frustumHeight).toFixed(2));

          // Cria sempre um objeto completamente novo para forçar re-render
          const newDebugInfo: DebugInfo = {
            camera: {
              x: parseFloat(camera.position.x.toFixed(2)),
              y: parseFloat(camera.position.y.toFixed(2)),
              z: parseFloat(camera.position.z.toFixed(2)),
            },
            cameraRotation: {
              x: parseFloat((camera.rotation.x * 180 / Math.PI).toFixed(1)),
              y: parseFloat((camera.rotation.y * 180 / Math.PI).toFixed(1)),
              z: parseFloat((camera.rotation.z * 180 / Math.PI).toFixed(1)),
            },
            lookAt: {
              x: parseFloat(lookAtPoint.x.toFixed(2)),
              y: parseFloat(lookAtPoint.y.toFixed(2)),
              z: parseFloat(lookAtPoint.z.toFixed(2)),
            },
            viewport: {
              width: renderer.domElement.width,
              height: renderer.domElement.height,
              aspect: parseFloat(camera.aspect.toFixed(3)),
              fov: camera.fov,
              near: camera.near,
              far: camera.far,
              frustumWidth: parseFloat(frustumWidth.toFixed(2)),
              frustumHeight: parseFloat(frustumHeight.toFixed(2)),
              distanceToOrigin,
              visibleArea,
            },
            objects: objectsInfo,
          };
          
          // Debug info atualizado em tempo real no overlay (console logs removidos para evitar duplicação)
          
          // Força atualização sempre criando objeto novo
          setDebugInfo({ ...newDebugInfo });
          setFrameCount(prev => prev + 1);
        };
        animate();

        const handleResize = () => {
          if (!containerRef.current) return;
          camera.aspect = containerRef.current.clientWidth / containerRef.current.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(containerRef.current.clientWidth, containerRef.current.clientHeight);
        };
        window.addEventListener('resize', handleResize);

        cleanupFunctionsRef.current.push(() => {
          console.log('🧹 Iniciando cleanup de recursos 3D...');
          
          // 1. Cancela animação primeiro
          if (animationId) {
            cancelAnimationFrame(animationId);
            console.log('  ✅ AnimationFrame cancelado');
          }
          
          // 2. Remove event listeners
          window.removeEventListener('resize', handleResize);
          
          // 3. Dispose controls
          controls.dispose();
          console.log('  ✅ Controls dispostos');
          
          // 4. Limpa objetos carregados e seus recursos ANTES de limpar a scene
          console.log('🧹 Limpando objetos 3D carregados...');
          sceneObjectsRef.current.forEach(({ name, object }) => {
            // Remove da scene primeiro
            if (scene && object.parent === scene) {
              scene.remove(object);
              console.log(`  🗑️ ${name} removido da scene`);
            }
            
            // Limpa geometria
            if (object.geometry) {
              object.geometry.dispose();
              console.log(`  ✅ Geometria de ${name} disposta`);
            }
            
            // Limpa material(is)
            if (object.material) {
              if (Array.isArray(object.material)) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                object.material.forEach((mat: any) => {
                  // Limpa texturas
                  if (mat.map) mat.map.dispose();
                  mat.dispose();
                });
              } else {
                // Limpa texturas
                if (object.material.map) object.material.map.dispose();
                object.material.dispose();
              }
              console.log(`  ✅ Material de ${name} disposto`);
            }
            
            // Limpa children recursivamente (para GLB)
            if (object.children && object.children.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              object.traverse((child: any) => {
                if (child.geometry) {
                  child.geometry.dispose();
                }
                if (child.material) {
                  if (Array.isArray(child.material)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    child.material.forEach((mat: any) => {
                      if (mat.map) mat.map.dispose();
                      mat.dispose();
                    });
                  } else {
                    if (child.material.map) child.material.map.dispose();
                    child.material.dispose();
                  }
                }
              });
            }
          });
          
          // 5. Limpa TODOS os objetos restantes da cena (cache)
          console.log('🧹 Limpando cache da scene...');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const objectsToRemove: any[] = [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          scene.traverse((object) => {
            if (object !== scene) {
              objectsToRemove.push(object);
              // Limpa recursos
              if (object instanceof THREE.Mesh || object instanceof THREE.Points) {
                if (object.geometry) {
                  object.geometry.dispose();
                }
                if (object.material) {
                  if (Array.isArray(object.material)) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    object.material.forEach((mat: any) => {
                      if (mat.map) mat.map.dispose();
                      mat.dispose();
                    });
                  } else {
                    if (object.material.map) object.material.map.dispose();
                    object.material.dispose();
                  }
                }
              }
            }
          });
          
          // Remove todos os objetos da scene
          objectsToRemove.forEach(obj => {
            if (obj.parent) {
              obj.parent.remove(obj);
            }
          });
          
          // 6. Clear final da scene
          scene.clear();
          console.log('  ✅ Scene completamente limpa');
          
          // 7. Limpa o frame buffer do renderer
          renderer.clear(true, true, true); // color, depth, stencil
          renderer.renderLists.dispose();
          console.log('  ✅ Frame buffer e render lists limpos');
          
          // 8. Remove canvas do DOM
          if (containerRef.current && containerRef.current.contains(renderer.domElement)) {
            containerRef.current.removeChild(renderer.domElement);
            console.log('  ✅ Canvas removido do DOM');
          }
          
          // 9. Dispose renderer
          renderer.dispose();
          console.log('🗑️ Renderer e todos os objetos descartados');
        });
      }
    };

    init();

    return () => {
      console.log('🧹 Iniciando cleanup...');
      cleanupFunctionsRef.current.forEach(fn => fn());
      cleanupFunctionsRef.current = []; // Limpa array de cleanup functions
      stopARCamera(); // Cleanup camera stream
      sceneObjectsRef.current = []; // Limpa referências de objetos
      sceneInitialized.current = false; // Reset flag para permitir nova inicialização
      console.log('✅ Cleanup completo: cena e objetos removidos, flag resetada');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelPaths, sceneEnabled]);

  return (
    <div 
      ref={containerRef} 
      className="w-full h-full" 
      style={{ position: 'relative', background: 'transparent', overflow: 'hidden' }} 
    >
      {/* Video Background para AR Camera - DEVE ficar atrás do canvas */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full"
        style={{ 
          objectFit: 'cover',
          display: useARCamera && isVideoReady ? 'block' : 'none',
          zIndex: 1,
        }}
      />

      {/* Modal de Solicitação de Câmera */}
      {showCameraPrompt && !useARCamera && (
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-gradient-to-br from-blue-600 to-purple-700 rounded-2xl p-6 max-w-md w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="text-center">
              <div className="text-6xl mb-4">📱</div>
              <h2 className="text-2xl font-bold text-white mb-3">Experiência AR</h2>
              <p className="text-white/90 mb-4 text-sm">
                Permita o acesso à câmera para visualizar os modelos 3D em realidade aumentada no seu ambiente.
              </p>
              
              {/* Aviso de protocolo */}
              {window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && (
                <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 mb-4">
                  <p className="text-red-200 text-xs font-bold mb-1">🔒 HTTPS Obrigatório</p>
                  <p className="text-red-200/80 text-xs">
                    A câmera só funciona em sites HTTPS. Você está acessando via {window.location.protocol}
                  </p>
                </div>
              )}
              
              <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-lg p-3 mb-4">
                <p className="text-yellow-200 text-xs">
                  ⚠️ Ao clicar, seu navegador pedirá permissão para acessar a câmera. Clique em &quot;Permitir&quot;.
                </p>
              </div>
              <div className="flex flex-col gap-3">
                <button
                  onClick={async () => {
                    setShowCameraPrompt(false);
                    await startARCamera();
                  }}
                  className="bg-white text-blue-600 px-6 py-3 rounded-xl font-bold text-lg hover:bg-blue-50 transition-colors shadow-lg"
                >
                  ✅ Ativar Câmera AR
                </button>
                <button
                  onClick={() => setShowCameraPrompt(false)}
                  className="bg-white/10 text-white px-6 py-2 rounded-xl font-semibold text-sm hover:bg-white/20 transition-colors"
                >
                  Usar Câmera Principal
                </button>
              </div>
              <p className="text-white/60 text-xs mt-4">
                💡 Funciona melhor em dispositivos móveis com giroscópio
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Botão para alternar câmera */}
      <div className="absolute top-2 left-2 z-50 flex gap-2 flex-wrap">
        {/* Checkbox para iniciar a cena - fica marcado e desabilitado após primeira ativação */}
        <label className={`${sceneEnabled ? 'bg-green-500' : 'bg-gray-500 hover:bg-green-600 cursor-pointer'} text-white px-4 py-2 rounded-lg font-semibold text-sm shadow-lg transition-colors flex items-center gap-2`}>
          <input
            type="checkbox"
            checked={sceneEnabled}
            disabled={sceneEnabled} // Desabilita após ser marcado
            onChange={(e) => {
              const enabled = e.target.checked;
              console.log(`🔄 Cena ${enabled ? 'habilitada' : 'desabilitada'}`);
              setSceneEnabled(enabled);
            }}
            className="w-4 h-4"
          />
          <span>{sceneEnabled ? '✅ Cena Ativa' : '▶️ Iniciar Cena'}</span>
        </label>
        
        <button
          onClick={() => {
            if (useARCamera) {
              stopARCamera();
            } else {
              startARCamera();
            }
          }}
          className="bg-blue-500 hover:bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold text-sm shadow-lg transition-colors"
        >
          {useARCamera ? '📷 Câmera Principal' : '📱 Câmera AR'}
        </button>
        
        {/* Botão para toggle debug overlay */}
        <button
          onClick={() => setShowDebugOverlay(!showDebugOverlay)}
          className="bg-purple-500 hover:bg-purple-600 text-white px-4 py-2 rounded-lg font-semibold text-sm shadow-lg transition-colors"
          title={showDebugOverlay ? 'Esconder Debug' : 'Mostrar Debug'}
        >
          {showDebugOverlay ? '🔽 Esconder Logs' : '🔼 Mostrar Logs'}
        </button>
        
        {useARCamera && !isVideoReady && (
          <div className="bg-yellow-500 text-black px-3 py-2 rounded-lg text-xs font-semibold">
            ⏳ Iniciando câmera...
          </div>
        )}
        {useARCamera && isVideoReady && (
          <div className="bg-green-500 text-white px-3 py-2 rounded-lg text-xs font-semibold">
            ✅ AR Ativa
          </div>
        )}
      </div>
      
      {/* Debug Info Overlay - Condicional */}
      {showDebugOverlay && (
        <div className="absolute top-2 right-2 bg-black/70 backdrop-blur-sm text-white p-3 rounded-lg text-xs font-mono z-50 max-w-xs max-h-[90vh] overflow-y-auto">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold text-sm text-green-400">📊 Debug Info</h3>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></div>
              <span className="text-[9px] text-gray-400">Frame: {frameCount}</span>
            </div>
          </div>
        
        {/* Camera Info */}
        <div className="mb-3 border-b border-white/20 pb-2">
          <p className="font-semibold text-yellow-300 mb-1">
            📷 Câmera: {useARCamera ? '📱 AR Mode' : '🖥️ Principal'}
          </p>
          <p className="text-[10px]">Posição:</p>
          <p className="ml-2">X: {debugInfo.camera.x}</p>
          <p className="ml-2">Y: {debugInfo.camera.y}</p>
          <p className="ml-2">Z: {debugInfo.camera.z}</p>
          <p className="text-[10px] mt-1">Rotação (graus):</p>
          <p className="ml-2">X: {debugInfo.cameraRotation.x}°</p>
          <p className="ml-2">Y: {debugInfo.cameraRotation.y}°</p>
          <p className="ml-2">Z: {debugInfo.cameraRotation.z}°</p>
          {useARCamera && isVideoReady && videoRef.current && (
            <>
              <p className="text-[10px] mt-1 text-cyan-300">📱 Video Stream:</p>
              <p className="ml-2 text-[9px]">Res: {videoRef.current.videoWidth}×{videoRef.current.videoHeight}</p>
              <p className="ml-2 text-[9px]">Aspect: {(videoRef.current.videoWidth / videoRef.current.videoHeight).toFixed(3)}</p>
              <p className="text-[10px] mt-1 text-pink-300">🧭 Device Orientation:</p>
              <p className="ml-2 text-[9px]">α (yaw): {deviceOrientationRef.current.alpha.toFixed(1)}°</p>
              <p className="ml-2 text-[9px]">β (pitch): {deviceOrientationRef.current.beta.toFixed(1)}°</p>
              <p className="ml-2 text-[9px]">γ (roll): {deviceOrientationRef.current.gamma.toFixed(1)}°</p>
            </>
          )}
          <p className="text-[10px] mt-1">Look At (direção):</p>
          <p className="ml-2">X: {debugInfo.lookAt.x}</p>
          <p className="ml-2">Y: {debugInfo.lookAt.y}</p>
          <p className="ml-2">Z: {debugInfo.lookAt.z}</p>
          
          {/* Botão para salvar câmera */}
          <button
            onClick={saveCamera}
            disabled={savedCameras.length >= 4}
            className={`mt-2 w-full py-1 px-2 rounded text-[9px] font-semibold ${
              savedCameras.length >= 4 
                ? 'bg-gray-500 cursor-not-allowed' 
                : 'bg-green-500 hover:bg-green-600'
            }`}
          >
            💾 Salvar Câmera ({savedCameras.length}/4)
          </button>
        </div>

        {/* Background Texture Control */}
        {texturePath && (
          <div className="mb-3 border-b border-white/20 pb-2">
            <p className="font-semibold text-purple-300 mb-2">🖼️ Background Texture:</p>
            <p className="text-[10px] text-gray-400 mb-2">
              {texturePath.split('/').pop()}
            </p>
            <button
              onClick={() => toggleBackgroundTexture(!bgTextureEnabled)}
              disabled={!bgTextureRef.current}
              className={`w-full py-1 px-2 rounded text-[9px] font-semibold ${
                !bgTextureRef.current
                  ? 'bg-gray-500 cursor-not-allowed'
                  : bgTextureEnabled
                  ? 'bg-orange-500 hover:bg-orange-600'
                  : 'bg-blue-500 hover:bg-blue-600'
              }`}
            >
              {!bgTextureRef.current ? '⏳ Carregando...' : bgTextureEnabled ? '🔲 Desativar (Transparente)' : '🖼️ Ativar Equirectangular'}
            </button>
            {bgTextureEnabled && (
              <p className="text-[9px] text-green-400 mt-1">✓ Ativa (Background + Environment)</p>
            )}
          </div>
        )}

        {/* Saved Cameras */}
        {savedCameras.length > 0 && (
          <div className="mb-3 border-b border-white/20 pb-2">
            <p className="font-semibold text-green-300 mb-2">📷 Câmeras Salvas:</p>
            
            {/* Botões de controle de animação */}
            {savedCameras.length >= 2 && (
              <div className="mb-2 flex gap-1">
                <button
                  onClick={createCameraAnimation}
                  disabled={isAnimating}
                  className={`flex-1 py-1 px-2 rounded text-[9px] font-semibold ${
                    isAnimating 
                      ? 'bg-gray-500 cursor-not-allowed' 
                      : 'bg-orange-500 hover:bg-orange-600'
                  }`}
                >
                  🎬 Criar Animação
                </button>
                {isAnimating ? (
                  <button
                    onClick={stopCameraAnimation}
                    className="flex-1 py-1 px-2 bg-red-500 hover:bg-red-600 rounded text-[9px] font-semibold"
                  >
                    ⏹️ Parar
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (savedCameras.length >= 2) {
                        createCameraAnimation();
                      }
                    }}
                    disabled={savedCameras.length < 2}
                    className={`flex-1 py-1 px-2 rounded text-[9px] font-semibold ${
                      savedCameras.length < 2
                        ? 'bg-gray-500 cursor-not-allowed'
                        : 'bg-green-500 hover:bg-green-600'
                    }`}
                  >
                    ▶️ Play
                  </button>
                )}
              </div>
            )}
            
            {/* Progress bar durante animação */}
            {isAnimating && (
              <div className="mb-2 bg-white/10 rounded-full h-2 overflow-hidden">
                <div 
                  className="bg-green-500 h-full transition-all duration-100"
                  style={{ width: `${animationProgressRef.current * 100}%` }}
                ></div>
              </div>
            )}
            
            {savedCameras.map((cam) => (
              <div key={cam.id} className="mb-2 p-2 bg-white/5 rounded border border-green-500/30">
                <div className="flex items-center justify-between mb-1">
                  <p className="text-[10px] font-semibold text-green-300">{cam.name}</p>
                  <button
                    onClick={() => deleteSavedCamera(cam.id)}
                    className="text-[9px] text-red-400 hover:text-red-300"
                  >
                    🗑️
                  </button>
                </div>
                <p className="text-[9px] text-gray-400">Pos: ({cam.position.x}, {cam.position.y}, {cam.position.z})</p>
                <p className="text-[9px] text-gray-400">Rot: ({cam.rotation.x}°, {cam.rotation.y}°, {cam.rotation.z}°)</p>
                <button
                  onClick={() => applySavedCamera(cam)}
                  className="mt-1 w-full py-1 px-2 bg-blue-500 hover:bg-blue-600 rounded text-[9px] font-semibold"
                >
                  ▶️ Aplicar
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Viewport Info */}
        <div className="mb-3 border-b border-white/20 pb-2">
          <p className="font-semibold text-purple-300 mb-1">🖥️ Viewport:</p>
          <p className="text-[10px]">Dimensões Canvas:</p>
          <p className="ml-2">{debugInfo.viewport.width} × {debugInfo.viewport.height}px</p>
          <p className="text-[10px] mt-1">Propriedades Câmera:</p>
          <p className="ml-2">FOV: {debugInfo.viewport.fov}°</p>
          <p className="ml-2">Aspect: {debugInfo.viewport.aspect}</p>
          <p className="ml-2">Near: {debugInfo.viewport.near}</p>
          <p className="ml-2">Far: {debugInfo.viewport.far}</p>
          <p className="text-[10px] mt-1 text-cyan-300">📐 Cálculos Matemáticos:</p>
          <p className="ml-2 text-[9px]">Dist. Origem: {debugInfo.viewport.distanceToOrigin}</p>
          <p className="ml-2 text-[9px]">Frustum W: {debugInfo.viewport.frustumWidth}</p>
          <p className="ml-2 text-[9px]">Frustum H: {debugInfo.viewport.frustumHeight}</p>
          <p className="ml-2 text-[9px]">Área Visível: {debugInfo.viewport.visibleArea}</p>
        </div>

        {/* Objects Info - Separado por tipo */}
        <div>
          <p className="font-semibold text-blue-300 mb-2">🎯 Objetos na Cena:</p>
          {debugInfo.objects.length === 0 ? (
            <p className="text-gray-400 text-[10px]">Carregando...</p>
          ) : (
            <>
              {/* GLB Models */}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {debugInfo.objects.filter((obj: any) => obj.name.toLowerCase().endsWith('.glb')).length > 0 && (
                <div className="mb-3">
                  <p className="font-semibold text-green-300 mb-1 text-[10px]">📦 GLB Models:</p>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {debugInfo.objects.filter((obj: any) => obj.name.toLowerCase().endsWith('.glb')).map((obj, idx) => (
                    <div key={`${obj.name}-${idx}`} className="mb-3 pl-2 border-l-2 border-green-500/50">
                      <div className="flex items-center gap-2 mb-2">
                        <p className="text-[10px] font-semibold text-green-200 flex-1">{obj.name}</p>
                        <button
                          onClick={() => playOpacityAnimation(obj.name)}
                          disabled={animatingObjects.has(obj.name)}
                          className={`px-2 py-1 rounded text-[9px] font-semibold ${
                            animatingObjects.has(obj.name)
                              ? 'bg-gray-500 cursor-not-allowed'
                              : 'bg-blue-500 hover:bg-blue-600'
                          }`}
                          title="Animar Opacity (0 → valor configurado)"
                        >
                          {animatingObjects.has(obj.name) ? '⏸️' : '▶️'}
                        </button>
                      </div>
                      
                      {/* Controles de Visibilidade e Opacity */}
                      <div className="mt-2 mb-2 space-y-1">
                        <div className="flex items-center gap-2">
                          <input 
                            type="checkbox"
                            defaultChecked={true}
                            onChange={(e) => toggleObjectVisibility(obj.name, e.target.checked)}
                            className="w-3 h-3"
                            id={`visible-${obj.name}`}
                          />
                          <label htmlFor={`visible-${obj.name}`} className="text-[9px] text-cyan-300">
                            👁️ Visível
                          </label>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] text-purple-300 w-16">🎨 Opacity:</span>
                          <input 
                            type="range"
                            min="0"
                            max="1"
                            step="0.1"
                            defaultValue="1"
                            onChange={(e) => {
                              const value = parseFloat(e.target.value);
                              updateObjectOpacity(obj.name, value);
                              const display = e.target.nextElementSibling;
                              if (display) display.textContent = `${Math.round(value * 100)}%`;
                            }}
                            className="flex-1 h-1"
                          />
                          <span className="text-[9px] text-white/60 w-8">100%</span>
                        </div>
                      </div>
                      
                      <p className="text-[9px] text-gray-300 mt-1">Posição:</p>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">X:</span>
                        <input 
                          key={`${obj.name}-x-${obj.position.x}`}
                          type="number" 
                          step="0.1"
                          defaultValue={obj.position.x}
                          onChange={(e) => updateObjectPosition(obj.name, 'x', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Y:</span>
                        <input 
                          key={`${obj.name}-y-${obj.position.y}`}
                          type="number" 
                          step="0.1"
                          defaultValue={obj.position.y}
                          onChange={(e) => updateObjectPosition(obj.name, 'y', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Z:</span>
                        <input 
                          key={`${obj.name}-z-${obj.position.z}`}
                          type="number" 
                          step="0.1"
                          defaultValue={obj.position.z}
                          onChange={(e) => updateObjectPosition(obj.name, 'z', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                      </div>
                      <p className="text-[9px] text-gray-300 mt-1">Rotação (graus):</p>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">X:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.x}
                          onChange={(e) => updateObjectRotation(obj.name, 'x', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Y:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.y}
                          onChange={(e) => updateObjectRotation(obj.name, 'y', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Z:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.z}
                          onChange={(e) => updateObjectRotation(obj.name, 'z', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              
              {/* PLY Models */}
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {debugInfo.objects.filter((obj: any) => obj.name.toLowerCase().endsWith('.ply')).length > 0 && (
                <div className="mb-3">
                  <p className="font-semibold text-yellow-300 mb-1 text-[10px]">☁️ PLY Models:</p>
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {debugInfo.objects.filter((obj: any) => obj.name.toLowerCase().endsWith('.ply')).map((obj, idx) => (
              <div key={`${obj.name}-${idx}`} className="mb-3 pl-2 border-l-2 border-blue-500/30">
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-[10px] font-semibold text-white/90 flex-1">{obj.name}</p>
                  <button
                    onClick={() => playOpacityAnimation(obj.name)}
                    disabled={animatingObjects.has(obj.name)}
                    className={`px-2 py-1 rounded text-[9px] font-semibold ${
                      animatingObjects.has(obj.name)
                        ? 'bg-gray-500 cursor-not-allowed'
                        : 'bg-blue-500 hover:bg-blue-600'
                    }`}
                    title="Animar Opacity (0 → valor configurado)"
                  >
                    {animatingObjects.has(obj.name) ? '⏸️' : '▶️'}
                  </button>
                </div>
                
                {/* Controles de Visibilidade e Opacity */}
                <div className="mt-2 mb-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <input 
                      type="checkbox"
                      defaultChecked={true}
                      onChange={(e) => toggleObjectVisibility(obj.name, e.target.checked)}
                      className="w-3 h-3"
                      id={`visible-${obj.name}`}
                    />
                    <label htmlFor={`visible-${obj.name}`} className="text-[9px] text-cyan-300">
                      👁️ Visível
                    </label>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-purple-300 w-16">🎨 Opacity:</span>
                    <input 
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      defaultValue="1"
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        updateObjectOpacity(obj.name, value);
                        // Atualiza o display do valor
                        const display = e.target.nextElementSibling;
                        if (display) display.textContent = `${Math.round(value * 100)}%`;
                      }}
                      className="flex-1 h-1"
                    />
                    <span className="text-[9px] text-white/60 w-8">100%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-yellow-300 w-16">💡 Brilho:</span>
                    <input 
                      type="range"
                      min="0"
                      max="10"
                      step="0.1"
                      defaultValue="1"
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        updateObjectBrightness(obj.name, value);
                        const display = e.target.nextElementSibling;
                        if (display) display.textContent = `${value.toFixed(1)}x`;
                      }}
                      className="flex-1 h-1"
                    />
                    <span className="text-[9px] text-white/60 w-8">1.0x</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[9px] text-blue-300 w-16">📏 Tamanho:</span>
                    <input 
                      type="range"
                      min="0.1"
                      max="10"
                      step="0.1"
                      defaultValue="2"
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        updateObjectPointSize(obj.name, value);
                        const display = e.target.nextElementSibling;
                        if (display) display.textContent = `${value.toFixed(1)}px`;
                      }}
                      className="flex-1 h-1"
                    />
                    <span className="text-[9px] text-white/60 w-8">2.0px</span>
                  </div>
                </div>
                
                <p className="text-[9px] text-gray-300 mt-1">Posição:</p>
                <div className="ml-2 flex items-center gap-1">
                  <span className="text-[9px] w-6">X:</span>
                  <input 
                    key={`${obj.name}-x-${obj.position.x}`}
                    type="number" 
                    step="0.1"
                    defaultValue={obj.position.x}
                    onChange={(e) => updateObjectPosition(obj.name, 'x', parseFloat(e.target.value) || 0)}
                    className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                  />
                </div>
                <div className="ml-2 flex items-center gap-1">
                  <span className="text-[9px] w-6">Y:</span>
                  <input 
                    key={`${obj.name}-y-${obj.position.y}`}
                    type="number" 
                    step="0.1"
                    defaultValue={obj.position.y}
                    onChange={(e) => updateObjectPosition(obj.name, 'y', parseFloat(e.target.value) || 0)}
                    className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                  />
                </div>
                <div className="ml-2 flex items-center gap-1">
                  <span className="text-[9px] w-6">Z:</span>
                  <input 
                    key={`${obj.name}-z-${obj.position.z}`}
                    type="number" 
                    step="0.1"
                    defaultValue={obj.position.z}
                    onChange={(e) => updateObjectPosition(obj.name, 'z', parseFloat(e.target.value) || 0)}
                    className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                  />
                </div>
                      <p className="text-[9px] text-gray-300 mt-1">Rotação (graus):</p>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">X:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.x}
                          onChange={(e) => updateObjectRotation(obj.name, 'x', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Y:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.y}
                          onChange={(e) => updateObjectRotation(obj.name, 'y', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <span className="text-[9px] w-6">Z:</span>
                        <input 
                          type="number" 
                          step="1"
                          defaultValue={obj.rotation.z}
                          onChange={(e) => updateObjectRotation(obj.name, 'z', parseFloat(e.target.value) || 0)}
                          className="w-14 bg-white/10 border border-white/20 rounded px-1 text-[9px] text-white"
                        />
                        <span className="text-[9px] text-white/60">°</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="mt-2 pt-2 border-t border-white/20 text-[9px] text-gray-400">
          <p>💡 Eixo UP: Z</p>
          <p>🔄 Atualização em tempo real</p>
          {useARCamera && (
            <>
              <p className="text-cyan-300 mt-1">📱 AR Camera Config:</p>
              <p>FOV: 53° (realista cross-device)</p>
              <p>Near: 0.01m / Far: 100m</p>
              <p>Escala: 1 unit = 1 metro</p>
              <p className="text-pink-300 mt-1">🎮 Fake 4DOF Ativo:</p>
              <p>Rotação + Posição baseada em giroscópio</p>
              <p>Mova o celular para ver o efeito!</p>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
