import { Center, Box, BoxProps } from '@chakra-ui/react';
import { debugData } from '../utils/debugData';
import { motion } from 'framer-motion';
import TopBar from './NavBars/TopBar';
import LeftBar from './NavBars/LeftBar';
import { Routes, Route } from 'react-router-dom';
import Resource from './Resource';
import RightBar from './NavBars/RightBar';
import MainContent from './MainContent';
import { useVisibility } from '../providers/VisibilityProvider';

debugData([
  {
    action: 'openUI',
    data: {
      resources: ['ox_inventory', 'luke_garages', 'es_extended'],
      totalQueries: 732,
      totalTime: 258,
    },
  },
]);

const MotionBox = motion<BoxProps>(Box);

const App: React.FC = () => {
  const { visible } = useVisibility();

  return (
    <Center w="100%" h="100%">
      <Box
        width="60%"
        height="50%"
        backgroundColor="#191E26"
        borderRadius="1vh"
        color="white"
        fontFamily="Poppins"
        userSelect="none"
      >
        <TopBar />
        <LeftBar />
        <RightBar />
        <MainContent>
          <Routes>
            <Route path="/:resource" element={<Resource />} />
          </Routes>
        </MainContent>
      </Box>
    </Center>
  );
};

export default App;